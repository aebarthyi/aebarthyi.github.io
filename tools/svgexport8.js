const fs=require('fs');
eval(fs.readFileSync('pipeline.js','utf8').replace(/\/\/ ---- run \+ validate[\s\S]*$/,''));

const {genALU}=require('./netlists.js');
const {genSeq,loadSeq,placeSeq}=require('./seq.js');
const {genMult,genBarrel,genCRC,genCmp}=require('./designs.js');
const DESIGNS={
  alu:    ()=>genALU(16),
  seq:    ()=>genSeq(16),
  mult:   ()=>genMult(6),
  barrel: ()=>genBarrel(16),
  crc:    ()=>genCRC(+(process.env.CRC_W||12)),
  cmp:    ()=>genCmp(16),
  adder:  ()=>genRippleAdder(8)
};
const DESIGN=process.argv[2]||'seq', QUIET=process.argv[3]==='--quiet';
const nl=loadSeq(DESIGNS[DESIGN]()), pl=placeSeq(nl);   // loadSeq handles gates AND flip-flops
const XS=1.00, YS=1.35;                      // extra channel/lane room for dense designs
const DX=pl.DX*XS, DY=pl.DY*YS, GW=54, GH=46, BG='#030603';
const TARGET_ROWS=+(process.env.TARGET_ROWS||12);
// Nodes inside one layer never connect to each other (edges always advance a
// layer), so a fat layer can be spread across several columns without breaking
// dataflow. That trades a little width for a much shorter, denser canvas.
const colOf=new Array(nl.nodes.length), rowOf=new Array(nl.nodes.length), colN=[];
{ let col=0;
  for(const L of pl.layers){
    const k=Math.max(1,Math.ceil(L.length/TARGET_ROWS));
    const sub=Array.from({length:k},()=>[]);
    L.forEach((ni,i)=>sub[i%k].push(ni));          // interleave so wires stay short
    for(const c of sub){ c.forEach((ni,r)=>{colOf[ni]=col;rowOf[ni]=r;}); colN[col]=c.length; col++; }
  } }
// integer row grid so lanes (row midpoints) are always clear of gate rows
const coord=nl.nodes.map((n,i)=>({x:colOf[i]*DX, y:(rowOf[i]-Math.floor(colN[colOf[i]]/2))*DY}));
const HW=GW*0.36, HH=GH*0.36;

const outP=i=>{const n=nl.nodes[i],c=coord[i];return n.kind==='in'?[c.x+10,c.y]:[c.x+HW,c.y];};
const inP=(i,port)=>{const n=nl.nodes[i],c=coord[i];if(n.kind==='out')return[c.x-10,c.y];
  const ny=(n.ins&&n.ins.length>=2)?(port===0?-0.13*GH:0.13*GH):0;return[c.x-HW,c.y+ny];};

// ---- label keep-out boxes so wires never cross text ----
const CHW=7.0, TH=9;
const labelBoxes=[];
nl.nodes.forEach((n,i)=>{ if(n.kind==='gate'||n.kind==='dff')return; const c=coord[i], w=(n.label||'').length*CHW;
  const px = n.kind==='in' ? c.x-10 : c.x+10;
  labelBoxes.push(n.kind==='in' ? {x0:px-w-5,x1:px+3,y0:c.y-TH,y1:c.y+TH}
                                : {x0:px-3,x1:px+w+5,y0:c.y-TH,y1:c.y+TH}); });
const hClear=(x1,x2,y)=>!labelBoxes.some(b=>y>b.y0&&y<b.y1&&Math.min(x1,x2)<b.x1&&Math.max(x1,x2)>b.x0);
const vClear=(x,y1,y2)=>!labelBoxes.some(b=>x>b.x0&&x<b.x1&&Math.min(y1,y2)<b.y1&&Math.max(y1,y2)>b.y0);

// ---- routing: vertical channels + horizontal lanes, track-assigned ----
const H=[],V=[];
let ROLE='?'; const pushH=(x1,x2,y,net)=>{ if(Math.abs(x1-x2)>0.5)H.push({x1:Math.min(x1,x2),x2:Math.max(x1,x2),y,net,r:ROLE}); };
const pushV=(x,y1,y2,net)=>{ if(Math.abs(y1-y2)>0.5)V.push({x,y1:Math.min(y1,y2),y2:Math.max(y1,y2),net,r:ROLE}); };
const CH_STEP=2, LN_STEP=2;                  // track capacity derived from real geometry
const CH_CAP=Math.max(3,Math.floor((DX-GW-16)/CH_STEP));
const LN_CAP=Math.max(3,Math.floor(2*(DY/2-HH-7)/LN_STEP));
const chT=new Map(), laneT=new Map(), rowUse=new Map();
// feedback (right-to-left) edges route around the outside on return lanes
const ROWS_Y=coord.map(c=>c.y);
const TOPY=Math.min(...ROWS_Y)-GH, BOTY=Math.max(...ROWS_Y)+GH, RET_STEP=7;
let retTop=0, retBot=0;
function rowFree(y,x1,x2,net){ const L=rowUse.get(y); if(!L)return true;
  const lo=Math.min(x1,x2)-2, hi=Math.max(x1,x2)+2;
  return !L.some(r=>r.net!==net && lo<r.x2 && r.x1<hi); }
function rowAdd(y,x1,x2,net){ if(!rowUse.has(y))rowUse.set(y,[]);
  rowUse.get(y).push({x1:Math.min(x1,x2)-2,x2:Math.max(x1,x2)+2,net}); }
const chOff=t=>(t-(CH_CAP-1)/2)*CH_STEP, lnOff=t=>(t-(LN_CAP-1)/2)*LN_STEP;
function probe(map,key,a,b,cap){ const lo=Math.min(a,b)-3,hi=Math.max(a,b)+3;
  let tr=map.get(key); if(!tr){tr=[];map.set(key,tr);}
  for(let t=0;t<tr.length;t++) if(!tr[t].some(iv=>lo<iv[1]&&iv[0]<hi)) return {t,tr,lo,hi,fresh:false};
  if(tr.length<cap) return {t:tr.length,tr,lo,hi,fresh:true};
  return null; }
function claim(r){ if(r.fresh) r.tr.push([[r.lo,r.hi]]); else r.tr[r.t].push([r.lo,r.hi]); }
function pickTrack(map,key,a,b,cap,xOf,test){    // claims only the track it returns
  const lo=Math.min(a,b)-3, hi=Math.max(a,b)+3;
  let tr=map.get(key); if(!tr){tr=[];map.set(key,tr);}
  for(let t=0;t<cap;t++){
    const iv = tr[t] || (tr[t]=[]);
    if(iv.some(v=>lo<v[1]&&v[0]<hi)) continue;
    const x=xOf(t); if(!test(x)) continue;
    iv.push([lo,hi]); return x;
  }
  return null;
}

for(const [net,driver] of nl.netDriver){
  const sinks=nl.netSinks.get(net)||[]; if(!sinks.length) continue;
  const o=outP(driver), dCol=Math.round(coord[driver].x/DX);
  for(const s of sinks){
    const p=inP(s.node,s.port), sCol=Math.round(coord[s.node].x/DX);
    let ex=pickTrack(chT,dCol+0.5,o[1],p[1],CH_CAP,t=>coord[driver].x+DX/2+chOff(t),
      x=>vClear(x,o[1],p[1])&&hClear(o[0],x,o[1])&&rowFree(o[1],o[0],x,net));
    if(ex===null) ex=coord[driver].x+DX/2+(((net*7)%CH_CAP)-CH_CAP/2)*CH_STEP;
    rowAdd(o[1],o[0],ex,net);

    if(sCol<=dCol){                                  // FEEDBACK: route around the outside
      const up=(net%2===0);
      const laneY = up ? (TOPY - (retTop++)*RET_STEP) : (BOTY + (retBot++)*RET_STEP);
      const spanO=[Math.min(o[1],laneY),Math.max(o[1],laneY)];
      const spanI=[Math.min(p[1],laneY),Math.max(p[1],laneY)];
      // exit channel: clear over the whole climb to the return lane
      let ex2=null;
      for(let a=0;a<CH_CAP;a++){ const r=probe(chT,dCol+0.5,spanO[0],spanO[1],CH_CAP); if(!r)break;
        const x=coord[driver].x+DX/2+chOff(r.t);
        if(vClear(x,spanO[0],spanO[1])&&hClear(o[0],x,o[1])&&rowFree(o[1],o[0],x,net)){ claim(r); ex2=x; break; }
        claim(r); }
      if(ex2===null) ex2=coord[driver].x+DX/2+(((net*7)%CH_CAP)-CH_CAP/2)*CH_STEP;
      // entry channel: clear over the whole descent into the flip-flop
      let en2=null;
      for(let a=0;a<CH_CAP;a++){ const r=probe(chT,sCol-0.5,spanI[0],spanI[1],CH_CAP); if(!r)break;
        const x=coord[s.node].x-DX/2+chOff(r.t);
        if(vClear(x,spanI[0],spanI[1])&&hClear(x,p[0],p[1])&&rowFree(p[1],x,p[0],net)){ claim(r); en2=x; break; }
        claim(r); }
      if(en2===null) en2=coord[s.node].x-DX/2+(((net*13)%CH_CAP)-CH_CAP/2)*CH_STEP;
      rowAdd(o[1],o[0],ex2,net); rowAdd(p[1],en2,p[0],net);
      ROLE='stubO'; pushH(o[0],ex2,o[1],net);
      ROLE='chan';  pushV(ex2,o[1],laneY,net);
      ROLE='lane';  pushH(ex2,en2,laneY,net);
      ROLE='chan';  pushV(en2,laneY,p[1],net);
      ROLE='stubI'; pushH(en2,p[0],p[1],net);
      continue;
    }
    if(sCol===dCol+1){ rowAdd(p[1],ex,p[0],net);
      ROLE='stubO'; pushH(o[0],ex,o[1],net); ROLE='chan'; pushV(ex,o[1],p[1],net); ROLE='stubI'; pushH(ex,p[0],p[1],net); continue; }

    const dir=(p[1]>=o[1])?1:-1;
    let en=pickTrack(chT,sCol-0.5,o[1],p[1],CH_CAP,t=>coord[s.node].x-DX/2+chOff(t),
      x=>vClear(x,o[1],p[1])&&hClear(x,p[0],p[1])&&rowFree(p[1],x,p[0],net));
    if(en===null) en=coord[s.node].x-DX/2+(((net*11)%CH_CAP)-CH_CAP/2)*CH_STEP;
    rowAdd(p[1],en,p[0],net);

    let laneY=null;
    outer: for(let step=0;step<5;step++){
      const cand=o[1]+dir*(DY/2+step*DY);
      if(dir>0 ? cand>p[1]+DY : cand<p[1]-DY) break;
      const y=pickTrack(laneT,cand,ex,en,LN_CAP,t=>cand+lnOff(t),yy=>hClear(ex,en,yy));
      if(y!==null){ laneY=y; break outer; } }
    if(laneY===null) laneY=o[1]+dir*DY/2;

    ROLE='stubO'; pushH(o[0],ex,o[1],net); ROLE='chan'; pushV(ex,o[1],laneY,net);
    ROLE='lane'; pushH(ex,en,laneY,net); ROLE='chan'; pushV(en,laneY,p[1],net);
    ROLE='stubI'; pushH(en,p[0],p[1],net);
  }
}

// ---- validation ----
const boxes=nl.nodes.map((n,i)=>(n.kind==='gate'||n.kind==='dff')?{x0:coord[i].x-HW,x1:coord[i].x+HW,y0:coord[i].y-HH,y1:coord[i].y+HH}:null).filter(Boolean);
let thru=0,txt=0,ovl=0;
H.forEach(s=>{ boxes.forEach(b=>{ if(s.y>b.y0&&s.y<b.y1&&s.x1<b.x1-1&&s.x2>b.x0+1)thru++; });
  labelBoxes.forEach(b=>{ if(s.y>b.y0&&s.y<b.y1&&s.x1<b.x1-1&&s.x2>b.x0+1)txt++; }); });
V.forEach(s=>{ boxes.forEach(b=>{ if(s.x>b.x0&&s.x<b.x1&&s.y1<b.y1-1&&s.y2>b.y0+1)thru++; });
  labelBoxes.forEach(b=>{ if(s.x>b.x0&&s.x<b.x1&&s.y1<b.y1-1&&s.y2>b.y0+1)txt++; }); });
const kinds={};
for(let i=0;i<H.length;i++)for(let j=i+1;j<H.length;j++){const a=H[i],b=H[j];
  if(a.net!==b.net&&Math.abs(a.y-b.y)<1&&a.x1<b.x2-2&&b.x1<a.x2-2){ovl++;
    const k=[a.r,b.r].sort().join('+'); kinds[k]=(kinds[k]||0)+1;}}
for(let i=0;i<V.length;i++)for(let j=i+1;j<V.length;j++){const a=V[i],b=V[j];
  if(a.net!==b.net&&Math.abs(a.x-b.x)<1&&a.y1<b.y2-2&&b.y1<a.y2-2){ovl++;
    const k='V:'+[a.r,b.r].sort().join('+'); kinds[k]=(kinds[k]||0)+1;}}
if(process.env.BREAKDOWN) console.log('  overlap breakdown:', JSON.stringify(kinds));

// ---- gate symbols (stroke inherited from group so they can light up) ----
function gateSVG(gid,cx,cy,w,h){
  const A=(fx,fy)=>(Math.round(cx-w/2+fx*w)+' '+Math.round(cy-h/2+fy*h));
  const R=(a,b)=>(Math.round(a*w)+' '+Math.round(b*h));
  const L=(x1,y1,x2,y2)=>'<line x1="'+Math.round(cx-w/2+x1*w)+'" y1="'+Math.round(cy-h/2+y1*h)+'" x2="'+Math.round(cx-w/2+x2*w)+'" y2="'+Math.round(cy-h/2+y2*h)+'"/>';
  const C=(fx,fy,r)=>'<circle cx="'+Math.round(cx-w/2+fx*w)+'" cy="'+Math.round(cy-h/2+fy*h)+'" r="'+Math.round(r*w)+'" fill="'+BG+'"/>';
  let body='', legA='', legB='';
  if(gid===1||gid===2){
    body+='<path d="M '+A(0.34,0.30)+' L '+A(0.34,0.70)+' L '+A(0.66,0.50)+' Z" fill="'+BG+'"/>';
    legA=L(0.14,0.50,0.34,0.50);
    body+= gid===2 ? C(0.705,0.50,0.045)+L(0.75,0.50,0.86,0.50) : L(0.66,0.50,0.86,0.50);
  } else if(gid===3||gid===4){
    body+='<path d="M '+A(0.38,0.30)+' L '+A(0.52,0.30)+' A '+R(0.20,0.20)+' 0 0 1 '+A(0.52,0.70)+' L '+A(0.38,0.70)+' Z" fill="'+BG+'"/>';
    legA=L(0.14,0.37,0.38,0.37); legB=L(0.14,0.63,0.38,0.63);
    body+= gid===4 ? C(0.775,0.50,0.045)+L(0.82,0.50,0.86,0.50) : L(0.72,0.50,0.86,0.50);
  } else if(gid===9){
    const x0=(cx-w/2+0.30*w).toFixed(1), y0=(cy-h/2+0.18*h).toFixed(1);
    body+='<rect x="'+x0+'" y="'+y0+'" width="'+Math.round(0.40*w)+'" height="'+Math.round(0.64*h)+'" fill="'+BG+'"/>';
    body+='<path d="M '+A(0.30,0.62)+' L '+A(0.38,0.69)+' L '+A(0.30,0.76)+'" fill="none"/>';  // clock notch
    legA=L(0.14,0.50,0.30,0.50);                       // D
    body+=L(0.70,0.50,0.86,0.50);                      // Q
  } else {
    body+='<path d="M '+A(0.34,0.30)+' Q '+A(0.54,0.32)+' '+A(0.72,0.50)+' Q '+A(0.54,0.68)+' '+A(0.34,0.70)+' Q '+A(0.46,0.50)+' '+A(0.34,0.30)+' Z" fill="'+BG+'"/>';
    if(gid===7||gid===8) body+='<path d="M '+A(0.28,0.30)+' Q '+A(0.40,0.50)+' '+A(0.28,0.70)+'" fill="none"/>';
    const bx=(gid===7||gid===8)?0.31:0.36;
    legA=L(0.14,0.37,bx,0.37); legB=L(0.14,0.63,bx,0.63);
    body+= (gid===6||gid===8) ? C(0.775,0.50,0.045)+L(0.82,0.50,0.86,0.50) : L(0.72,0.50,0.86,0.50);
  }
  return {body,legA,legB};
}

// ---- assemble SVG, grouped per net ----
let mnX=1e9,mnY=1e9,mxX=-1e9,mxY=-1e9;
coord.forEach(c=>{mnX=Math.min(mnX,c.x-GW);mxX=Math.max(mxX,c.x+GW);mnY=Math.min(mnY,c.y-GH);mxY=Math.max(mxY,c.y+GH);});
labelBoxes.forEach(b=>{mnX=Math.min(mnX,b.x0);mxX=Math.max(mxX,b.x1);});
H.forEach(s=>{mnY=Math.min(mnY,s.y-6);mxY=Math.max(mxY,s.y+6);});
V.forEach(s=>{mnY=Math.min(mnY,s.y1-6);mxY=Math.max(mxY,s.y2+6);});
const M=26, W=Math.round(mxX-mnX+2*M), Hh=Math.round(mxY-mnY+2*M), ox=M-mnX, oy=M-mnY;
const TX=x=>Math.round(x+ox), TY=y=>Math.round(y+oy);

const RN=v=>Math.round(v);
const byNet=new Map();
const add=(net,frag)=>{ if(!byNet.has(net))byNet.set(net,[]); byNet.get(net).push(frag); };
V.forEach(s=>add(s.net,'M'+RN(TX(s.x))+' '+RN(TY(s.y1))+'V'+RN(TY(s.y2))));
H.forEach(s=>add(s.net,'M'+RN(TX(s.x1))+' '+RN(TY(s.y))+'H'+RN(TX(s.x2))));

let svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+W+' '+Hh+'" font-family="ui-monospace,monospace">';
svg+='<g class="wires" fill="none" stroke-width="1.4" stroke-linecap="round">';
for(const [net,ds] of byNet) svg+='<path class="w" data-net="'+net+'" d="'+ds.join('')+'"/>';
svg+='</g><g class="syms" fill="none" stroke-width="1.4" stroke-linejoin="round">';
nl.nodes.forEach((n,i)=>{ if(n.kind!=='gate'&&n.kind!=='dff')return;
  const gp=gateSVG(n.glyph||3,TX(coord[i].x),TY(coord[i].y),GW,GH);
  svg+='<g class="s" data-net="'+n.outNet+'">'+gp.body+'</g>';           // body+output = gate value
  if(gp.legA && n.ins[0]!=null) svg+='<g class="s" data-net="'+n.ins[0]+'">'+gp.legA+'</g>';  // input A
  if(gp.legB && n.ins[1]!=null) svg+='<g class="s" data-net="'+n.ins[1]+'">'+gp.legB+'</g>'; });
svg+='</g><g class="pins" stroke="none">';
nl.nodes.forEach((n,i)=>{ if(n.kind==='gate'||n.kind==='dff')return; const net=n.kind==='in'?n.outNet:n.ins[0];
  svg+='<g class="p" data-net="'+net+'"><circle cx="'+TX(coord[i].x)+'" cy="'+TY(coord[i].y)+'" r="3.4"/></g>'; });
svg+='</g><g class="labels" stroke="none">';
nl.nodes.forEach((n,i)=>{ if(n.kind==='gate'||n.kind==='dff')return; const e=n.kind==='in';
  svg+='<text x="'+(TX(coord[i].x)+(e?-9:9))+'" y="'+(TY(coord[i].y)+4)+'" font-size="11" text-anchor="'+(e?'end':'start')+'">'+n.label+'</text>'; });
svg+='</g></svg>';

// ---- simulation model for the browser ----
const order=nl.nodes.map((n,i)=>i).sort((a,b)=>pl.layer[a]-pl.layer[b]);
const SIM={ inputs:nl.nodes.filter(n=>n.kind==='in').map(n=>n.outNet),
  nodes:order.map(i=>{const n=nl.nodes[i];
    const k = n.kind==='gate'?'g' : n.kind==='dff'?'d' : n.kind==='in'?'i':'o';
    return {k, g:n.glyph||0, in:n.ins||[], o:(n.outNet===undefined?null:n.outNet), L:pl.layer[i]};}),
  dffs:nl.nodes.filter(n=>n.kind==='dff').map(n=>({d:n.ins[0], q:n.outNet})),
  seq:nl.nodes.some(n=>n.kind==='dff'),
  maxL:pl.maxL };

const nan=(svg.match(/NaN|undefined/g)||[]).length;
if(nan){ console.error('FATAL: NaN in output'); process.exit(1); }
if(!QUIET){ fs.writeFileSync('out_'+DESIGN+'.svg',svg); fs.writeFileSync('out_'+DESIGN+'.json',JSON.stringify(SIM)); }
console.log(DESIGN.padEnd(7)+': gates '+boxes.length+' | segs '+(H.length+V.length)+' | nets '+byNet.size+
  ' | thru-gate '+thru+' | thru-text '+txt+' | overlaps '+ovl+' | cols '+colN.length+' | maxrows '+Math.max(...colN)+
  ' | fill '+(100*nl.nodes.length/(Math.max(...colN)*colN.length)).toFixed(0)+'% | '+W+'x'+Hh);

// sim self-test
function ev(vals){ for(const n of SIM.nodes){ if(n.k!=='g')continue;
  const a=vals[n.in[0]]|0, b=vals[n.in[1]]|0;
  vals[n.o]= n.g===1?a : n.g===2?(a^1) : n.g===3?(a&b) : n.g===4?((a&b)^1)
           : n.g===5?(a|b) : n.g===6?((a|b)^1) : n.g===7?(a^b) : ((a^b)^1); } return vals; }
let hi=0, tot=0;
for(let trial=0;trial<(SIM.seq?0:5);trial++){ const vals={}; SIM.inputs.forEach(net=>vals[net]=Math.random()<0.5?1:0);
  ev(vals); const vs=Object.values(vals); tot+=vs.length; hi+=vs.filter(v=>v===1).length; }
if(!SIM.seq) console.log('  sim: '+(tot/5)+' nets/eval, avg '+(100*hi/tot).toFixed(0)+'% high');
else console.log('  sequential: '+SIM.dffs.length+' flip-flops, clocked simulation');
