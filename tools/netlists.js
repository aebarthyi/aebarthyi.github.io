// 8-bit ALU in Yosys write_json schema, mapped to primitive gates.
// ops: 00=ADD  01=SUB  10=AND  11=OR
function genALU(n){
  let nid=2; const net=()=>nid++;
  const ports={}, cells={}, netnames={};
  let g=0;
  const G=(type,ins,Y)=>{ const conn={}; const dirs={};
    if(ins.length===1){ conn.A=[ins[0]]; dirs.A='input'; } else { conn.A=[ins[0]]; conn.B=[ins[1]]; dirs.A='input'; dirs.B='input'; }
    conn.Y=[Y]; dirs.Y='output';
    cells['g'+(g++)+'_'+type.replace(/[^A-Z]/g,'').toLowerCase()]={hide_name:0,type,port_directions:dirs,connections:conn};
    return Y; };
  const AND=(a,b)=>G('$_AND_',[a,b],net()), OR=(a,b)=>G('$_OR_',[a,b],net()),
        XOR=(a,b)=>G('$_XOR_',[a,b],net()), NOT=a=>G('$_NOT_',[a],net());

  const a=[],b=[],op=[];
  for(let i=0;i<n;i++){a[i]=net();b[i]=net();}
  op[0]=net(); op[1]=net();
  ports['a']={direction:'input',bits:a.slice()};
  ports['b']={direction:'input',bits:b.slice()};
  ports['op']={direction:'input',bits:op.slice()};
  a.forEach((x,i)=>netnames['a['+i+']']={hide_name:0,bits:[x]});
  b.forEach((x,i)=>netnames['b['+i+']']={hide_name:0,bits:[x]});
  op.forEach((x,i)=>netnames['op['+i+']']={hide_name:0,bits:[x]});

  // control decode
  const n0=NOT(op[0]), n1=NOT(op[1]);
  const selAdd=AND(n1,n0), selSub=AND(n1,op[0]);
  const selAnd=AND(op[1],n0), selOr=AND(op[1],op[0]);
  const arith=OR(selAdd,selSub);

  // datapath
  const y=[]; let carry=selSub;                 // SUB = add with inverted b and carry-in 1
  for(let i=0;i<n;i++){
    const be=XOR(b[i],selSub);
    const x=XOR(a[i],be), sum=XOR(x,carry);
    const c1=AND(a[i],be), c2=AND(x,carry);
    carry=OR(c1,c2);
    const andi=AND(a[i],b[i]), ori=OR(a[i],b[i]);
    const m1=AND(sum,arith), m2=AND(andi,selAnd), m3=AND(ori,selOr);
    y[i]=OR(OR(m1,m2),m3);
  }
  ports['y']={direction:'output',bits:y.slice()};
  ports['cout']={direction:'output',bits:[carry]};
  y.forEach((x,i)=>netnames['y['+i+']']={hide_name:0,bits:[x]});
  netnames['cout']={hide_name:0,bits:[carry]};

  return {creator:'alu (Yosys write_json schema)',
    modules:{['alu'+n]:{attributes:{top:'00000000000000000000000000000001'},ports,cells,netnames}}};
}
if(typeof module!=='undefined') module.exports={genALU};
