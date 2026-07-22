// Sequential design + DFF-aware loading/placement/simulation.
// 16-bit Fibonacci LFSR (taps 16,14,13,11) feeding a 16-bit accumulator.
// Self-running: no primary inputs except the clock, so the animation is the
// circuit actually executing rather than random stimulus.

function genSeq(n){
  let nid=2; const net=()=>nid++;
  const ports={}, cells={}, netnames={};
  let g=0;
  const cell=(type,conns,dirs)=>{ cells['c'+(g++)+'_'+type.replace(/[^A-Z]/g,'').toLowerCase()]=
    {hide_name:0,type,port_directions:dirs,connections:conns}; };
  const bin=(type,a,b)=>{ const y=net();
    cell(type,{A:[a],B:[b],Y:[y]},{A:'input',B:'input',Y:'output'}); return y; };
  const XOR=(a,b)=>bin('$_XOR_',a,b), AND=(a,b)=>bin('$_AND_',a,b), OR=(a,b)=>bin('$_OR_',a,b);

  const clk=net();
  ports['clk']={direction:'input',bits:[clk]};
  netnames['clk']={hide_name:0,bits:[clk]};

  // flip-flop state nets (Q side)
  const lq=[], aq=[];
  for(let i=0;i<n;i++){ lq[i]=net(); aq[i]=net(); }

  // --- LFSR feedback: taps at bits n-1, n-3, n-4, n-6 ---
  const t=[n-1,n-3,n-4,n-6].filter(i=>i>=0);
  let fb=lq[t[0]]; for(let k=1;k<t.length;k++) fb=XOR(fb,lq[t[k]]);

  // --- accumulator: acc + lfsr (ripple carry) ---
  const sum=[]; let carry=null;
  for(let i=0;i<n;i++){
    const x=XOR(aq[i],lq[i]);
    if(carry===null){ sum[i]=x; carry=AND(aq[i],lq[i]); }
    else{
      sum[i]=XOR(x,carry);
      carry=OR(AND(aq[i],lq[i]), AND(x,carry));
    }
  }

  // --- flip-flops (D side) ---
  for(let i=0;i<n;i++){
    const d = (i===0) ? fb : lq[i-1];                     // LFSR shifts up
    cell('$_DFF_P_',{C:[clk],D:[d],Q:[lq[i]]},{C:'input',D:'input',Q:'output'});
    netnames['lfsr['+i+']']={hide_name:0,bits:[lq[i]]};
  }
  for(let i=0;i<n;i++){
    cell('$_DFF_P_',{C:[clk],D:[sum[i]],Q:[aq[i]]},{C:'input',D:'input',Q:'output'});
    netnames['acc['+i+']']={hide_name:0,bits:[aq[i]]};
  }

  ports['acc']={direction:'output',bits:aq.slice()};
  return {creator:'lfsr+accumulator (Yosys write_json schema)',
    modules:{['seq'+n]:{attributes:{top:'00000000000000000000000000000001'},ports,cells,netnames}}};
}

// ---- loader: gates + DFFs. Clock is deliberately NOT routed (standard
// schematic convention for a global clock); DFF Q acts as a graph source, so
// feedback loops are broken and the combinational part stays a DAG. ----
const GATE={'$_BUF_':{g:1,ins:['A']},'$_NOT_':{g:2,ins:['A']},
  '$_AND_':{g:3,ins:['A','B']},'$_NAND_':{g:4,ins:['A','B']},'$_OR_':{g:5,ins:['A','B']},
  '$_NOR_':{g:6,ins:['A','B']},'$_XOR_':{g:7,ins:['A','B']},'$_XNOR_':{g:8,ins:['A','B']}};
const DFF_GLYPH=9;

function loadSeq(json){
  const mods=json.modules;
  const name=Object.keys(mods).find(k=>mods[k].attributes&&mods[k].attributes.top)||Object.keys(mods)[0];
  const mod=mods[name], nodes=[], netDriver=new Map(), netSinks=new Map();
  const addSink=(net,ni,p)=>{ (netSinks.get(net)||netSinks.set(net,[]).get(net)).push({node:ni,port:p}); };
  const clkNets=new Set();
  for(const [pn,p] of Object.entries(mod.ports)) if(pn==='clk') p.bits.forEach(b=>clkNets.add(b));

  // inputs (excluding clock)
  for(const [pn,p] of Object.entries(mod.ports)) if(p.direction==='input' && pn!=='clk')
    p.bits.forEach((bit,i)=>{ const ni=nodes.length;
      nodes.push({kind:'in',label:p.bits.length>1?pn+'['+i+']':pn,outNet:bit,ins:[]}); netDriver.set(bit,ni); });

  // cells
  for(const [,c] of Object.entries(mod.cells)){
    const ni=nodes.length;
    if(c.type==='$_DFF_P_'||c.type==='$_DFF_N_'){
      const d=c.connections.D[0], q=c.connections.Q[0];
      nodes.push({kind:'dff',glyph:DFF_GLYPH,type:c.type,ins:[d],outNet:q});
      netDriver.set(q,ni); addSink(d,ni,0);            // Q is a source -> loop broken
    } else {
      const spec=GATE[c.type];
      if(spec){ const ins=spec.ins.map(p=>c.connections[p][0]), y=c.connections.Y[0];
        nodes.push({kind:'gate',glyph:spec.g,type:c.type,ins,outNet:y});
        netDriver.set(y,ni); ins.forEach((nt,k)=>addSink(nt,ni,k)); }
      else { const y=(c.connections.Y||[null])[0];
        const ins=Object.entries(c.connections).filter(([p])=>p!=='Y').flatMap(([,b])=>b);
        nodes.push({kind:'gate',glyph:0,type:c.type,ins,outNet:y});
        if(y!=null) netDriver.set(y,ni); ins.forEach((nt,k)=>addSink(nt,ni,k)); }
    }
  }
  for(const [pn,p] of Object.entries(mod.ports)) if(p.direction==='output')
    p.bits.forEach((bit,i)=>{ const ni=nodes.length;
      nodes.push({kind:'out',label:p.bits.length>1?pn+'['+i+']':pn,ins:[bit]}); addSink(bit,ni,0); });

  return {name,nodes,netDriver,netSinks,clkNets};
}

// ---- layering: DFFs and inputs are sources (layer 0) ----
function placeSeq(nl){
  const {nodes,netDriver,netSinks}=nl, layer=new Array(nodes.length).fill(-1);
  const drv=net=>netDriver.has(net)?netDriver.get(net):-1;
  const comp=ni=>{ if(layer[ni]>=0) return layer[ni];
    const n=nodes[ni];
    if(n.kind==='in'||n.kind==='dff') return layer[ni]=0;   // state elements start the frame
    layer[ni]=0; let mx=0;
    for(const net of (n.ins||[])){ const d=drv(net);
      if(d<0||d===ni) continue;
      // a flip-flop is a SOURCE at layer 0 (its feedback edge is cut), but the
      // node reading it still advances a layer -- skipping that collapsed the
      // whole design onto layer 0.
      const dl = nodes[d].kind==='dff' ? 0 : comp(d);
      mx=Math.max(mx, dl+1); }
    return layer[ni]=mx; };
  for(let i=0;i<nodes.length;i++) comp(i);
  const maxL=Math.max(...layer), layers=Array.from({length:maxL+1},()=>[]);
  nodes.forEach((n,i)=>layers[layer[i]].push(i));
  const pos=new Array(nodes.length); layers.forEach(L=>L.forEach((ni,k)=>pos[ni]=k));
  const bIn=ni=>{const ps=(nodes[ni].ins||[]).map(nt=>{const d=drv(nt);return d>=0?pos[d]:null;}).filter(x=>x!=null);
    return ps.length?ps.reduce((a,b)=>a+b)/ps.length:pos[ni];};
  const bOut=ni=>{const o=nodes[ni].outNet,ss=(o!=null&&netSinks.get(o))||[];
    const ps=ss.map(s=>pos[s.node]); return ps.length?ps.reduce((a,b)=>a+b)/ps.length:pos[ni];};
  for(let s=0;s<6;s++){
    for(let l=1;l<=maxL;l++){layers[l].sort((a,b)=>bIn(a)-bIn(b));layers[l].forEach((ni,k)=>pos[ni]=k);}
    for(let l=maxL-1;l>=0;l--){layers[l].sort((a,b)=>bOut(a)-bOut(b));layers[l].forEach((ni,k)=>pos[ni]=k);}
  }
  const DX=150,DY=70,coord=new Array(nodes.length);
  layers.forEach(L=>{const h=(L.length-1)*DY;L.forEach((ni,k)=>coord[ni]={x:layer[ni]*DX,y:k*DY-h/2});});
  return {layer,pos,coord,layers,DX,DY,maxL,W:(maxL+1)*DX,H:Math.max(...layers.map(L=>L.length))*DY};
}

// ---- clocked simulation: settle combinational logic, then latch D -> Q ----
function makeSim(nl,pl){
  const order=nl.nodes.map((n,i)=>i).sort((a,b)=>pl.layer[a]-pl.layer[b]);
  const dffs=nl.nodes.map((n,i)=>n.kind==='dff'?{i,d:n.ins[0],q:n.outNet}:null).filter(Boolean);
  const vals={};
  dffs.forEach((f,k)=>vals[f.q]= k<4?1:0);                 // nonzero seed so the LFSR runs
  function settle(){
    for(const i of order){ const n=nl.nodes[i];
      if(n.kind!=='gate') continue;
      const a=vals[n.ins[0]]|0, b=vals[n.ins[1]]|0, g=n.glyph;
      vals[n.outNet]= g===1?a : g===2?(a^1) : g===3?(a&b) : g===4?((a&b)^1)
                    : g===5?(a|b) : g===6?((a|b)^1) : g===7?(a^b) : ((a^b)^1); }
  }
  function tick(){ settle(); const nx=dffs.map(f=>vals[f.d]|0);
    dffs.forEach((f,k)=>vals[f.q]=nx[k]); settle(); }
  return {vals,tick,settle,dffs,order};
}

if(typeof module!=='undefined') module.exports={genSeq,loadSeq,placeSeq,makeSim,DFF_GLYPH};
