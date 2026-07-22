// ---- generate a ripple-carry adder netlist in Yosys write_json schema ----
function genRippleAdder(n){
  let nid=2; const net=()=>nid++;
  const ports={}, cells={}, netnames={};
  const a=[],b=[],sum=[]; let cin,cout;
  for(let i=0;i<n;i++){ a[i]=net(); b[i]=net(); }
  cin=net();
  ports['a']={direction:'input',bits:a.slice()};
  ports['b']={direction:'input',bits:b.slice()};
  ports['cin']={direction:'input',bits:[cin]};
  a.forEach((x,i)=>netnames['a['+i+']']={hide_name:0,bits:[x]});
  b.forEach((x,i)=>netnames['b['+i+']']={hide_name:0,bits:[x]});
  netnames['cin']={hide_name:0,bits:[cin]};
  let carry=cin; let g=0;
  const gate=(type,A,B,Y)=>{ cells['g'+(g++)+'_'+type.replace(/[^A-Z]/g,'').toLowerCase()]={
    hide_name:0,type,port_directions:{A:'input',B:'input',Y:'output'},connections:{A:[A],B:[B],Y:[Y]}}; };
  for(let i=0;i<n;i++){
    const x=net(), aa=net(), cc=net(); sum[i]=net(); const co=(i===n-1)?net():net();
    gate('$_XOR_',a[i],b[i],x);          // a^b
    gate('$_XOR_',x,carry,sum[i]);       // ^cin -> sum
    gate('$_AND_',a[i],b[i],aa);         // a&b
    gate('$_AND_',x,carry,cc);           // (a^b)&cin
    gate('$_OR_', aa,cc,co);             // carry out
    netnames['x['+i+']']={hide_name:0,bits:[x]};
    carry=co; if(i===n-1) cout=co;
  }
  ports['sum']={direction:'output',bits:sum.slice()};
  ports['cout']={direction:'output',bits:[cout]};
  sum.forEach((x,i)=>netnames['sum['+i+']']={hide_name:0,bits:[x]});
  netnames['cout']={hide_name:0,bits:[cout]};
  return {creator:'ripple-carry (Yosys write_json schema)',modules:{['add'+n]:{attributes:{top:'00000000000000000000000000000001'},ports,cells,netnames}}};
}

// ---- loader: Yosys JSON -> node/edge graph (shared with the browser) ----
const GATE={'$_BUF_':{g:1,ins:['A']},'$_NOT_':{g:2,ins:['A']},
  '$_AND_':{g:3,ins:['A','B']},'$_NAND_':{g:4,ins:['A','B']},'$_OR_':{g:5,ins:['A','B']},
  '$_NOR_':{g:6,ins:['A','B']},'$_XOR_':{g:7,ins:['A','B']},'$_XNOR_':{g:8,ins:['A','B']}};
function loadNetlist(json){
  const mods=json.modules; const name=Object.keys(mods).find(n=>mods[n].attributes&&mods[n].attributes.top)||Object.keys(mods)[0];
  const mod=mods[name]; const nodes=[]; const netDriver=new Map(), netSinks=new Map();
  const addSink=(net,ni,port)=>{ (netSinks.get(net)||netSinks.set(net,[]).get(net)).push({node:ni,port}); };
  for(const [pn,p] of Object.entries(mod.ports)) if(p.direction==='input')
    p.bits.forEach((bit,i)=>{ const ni=nodes.length; nodes.push({kind:'in',label:p.bits.length>1?pn+'['+i+']':pn,outNet:bit,ins:[]}); netDriver.set(bit,ni); });
  for(const [cid,cell] of Object.entries(mod.cells)){
    const spec=GATE[cell.type], ni=nodes.length;
    if(spec){ const ins=spec.ins.map(pn=>cell.connections[pn][0]); const outNet=cell.connections.Y[0];
      nodes.push({kind:'gate',glyph:spec.g,type:cell.type,ins,outNet,label:cell.type.replace(/[$_]/g,'')});
      netDriver.set(outNet,ni); ins.forEach((net,k)=>addSink(net,ni,k)); }
    else { const outNet=(cell.connections.Y||[null])[0];
      const ins=Object.entries(cell.connections).filter(([pn])=>pn!=='Y').flatMap(([,b])=>b);
      nodes.push({kind:'gate',glyph:0,type:cell.type,ins,outNet,label:cell.type.replace(/[$_]/g,'')});
      if(outNet!=null)netDriver.set(outNet,ni); ins.forEach((net,k)=>addSink(net,ni,k)); } }
  for(const [pn,p] of Object.entries(mod.ports)) if(p.direction==='output')
    p.bits.forEach((bit,i)=>{ const ni=nodes.length; nodes.push({kind:'out',label:p.bits.length>1?pn+'['+i+']':pn,ins:[bit]}); addSink(bit,ni,0); });
  return {name,nodes,netDriver,netSinks};
}

// ---- layered placement (Sugiyama-style: layer by logic depth, barycenter ordering) ----
function placeNetlist(nl){
  const {nodes,netDriver,netSinks}=nl; const layer=new Array(nodes.length).fill(-1);
  const drv=net=>netDriver.has(net)?netDriver.get(net):-1;
  const comp=ni=>{ if(layer[ni]>=0)return layer[ni]; const n=nodes[ni];
    if(n.kind==='in')return layer[ni]=0; layer[ni]=0; let mx=0;
    for(const net of (n.ins||[])){ const d=drv(net); if(d>=0&&d!==ni) mx=Math.max(mx,comp(d)+1); } return layer[ni]=mx; };
  for(let i=0;i<nodes.length;i++) comp(i);
  const maxL=Math.max(...layer); const layers=Array.from({length:maxL+1},()=>[]);
  nodes.forEach((n,i)=>layers[layer[i]].push(i));
  const pos=new Array(nodes.length); layers.forEach(L=>L.forEach((ni,k)=>pos[ni]=k));
  const bIn=ni=>{const ps=(nodes[ni].ins||[]).map(net=>{const d=drv(net);return d>=0?pos[d]:null;}).filter(x=>x!=null);return ps.length?ps.reduce((a,b)=>a+b)/ps.length:pos[ni];};
  const bOut=ni=>{const o=nodes[ni].outNet,ss=(o!=null&&netSinks.get(o))||[];const ps=ss.map(s=>pos[s.node]);return ps.length?ps.reduce((a,b)=>a+b)/ps.length:pos[ni];};
  for(let s=0;s<6;s++){
    for(let l=1;l<=maxL;l++){layers[l].sort((a,b)=>bIn(a)-bIn(b));layers[l].forEach((ni,k)=>pos[ni]=k);}
    for(let l=maxL-1;l>=0;l--){layers[l].sort((a,b)=>bOut(a)-bOut(b));layers[l].forEach((ni,k)=>pos[ni]=k);}
  }
  const DX=150,DY=70,coord=new Array(nodes.length);
  layers.forEach(L=>{const h=(L.length-1)*DY;L.forEach((ni,k)=>coord[ni]={x:layer[ni]*DX,y:k*DY-h/2});});
  const maxRows=Math.max(...layers.map(L=>L.length));
  return {layer,pos,coord,layers,DX,DY,W:(maxL+1)*DX,H:maxRows*DY,maxL};
}

// ---- run + validate ----
const json=genRippleAdder(4);
require('fs').writeFileSync('netlist.json',JSON.stringify(json));
const nl=loadNetlist(json), pl=placeNetlist(nl);
// validate: every gate input driven from a strictly-lower layer (combinational DAG)
let bad=0; nl.nodes.forEach((n,i)=>{ if(n.kind!=='in') for(const net of (n.ins||[])){ const d=nl.netDriver.get(net); if(d!=null && pl.layer[d]>=pl.layer[i]) bad++; }});
const counts={}; nl.nodes.forEach(n=>counts[n.kind]=(counts[n.kind]||0)+1);
console.log('module:',nl.name,'| nodes:',nl.nodes.length,counts,'| layers:',pl.maxL+1,'| back-edges:',bad);
// tiny ASCII: one char per node, columns=layers
const glyphCh={0:'?',1:'▷',2:'!',3:'&',4:'⊼',5:'≥',6:'⊽',7:'=',8:'⊙'};
for(let r=0;r<Math.max(...pl.layers.map(L=>L.length));r++){ let line='';
  for(let l=0;l<=pl.maxL;l++){ const ni=pl.layers[l][r];
    if(ni==null){line+='   ';continue;} const n=nl.nodes[ni];
    line+= (n.kind==='in'?'▸':n.kind==='out'?'▹':glyphCh[n.glyph]||'?')+'  '; }
  console.log(line); }
console.log('\nlegend: ▸in ▹out  &AND ≥OR =XOR !NOT  | layout '+pl.W+'x'+pl.H+' units, wrote netlist.json ('+JSON.stringify(json).length+' bytes)');
