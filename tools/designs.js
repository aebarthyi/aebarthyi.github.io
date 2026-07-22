// Extra designs, all emitted in Yosys write_json schema with primitive cells.
// No constant nets are used anywhere (rotate instead of shift, MSB-seeded
// comparator chain), so every wire has a real driver and lights correctly.

function builder(){
  let nid=2, g=0;
  const ports={}, cells={}, netnames={};
  const net=()=>nid++;
  const cell=(type,conns,dirs)=>{ cells['c'+(g++)+'_'+type.replace(/[^A-Z]/g,'').toLowerCase()]=
    {hide_name:0,type,port_directions:dirs,connections:conns}; };
  const bin=(t,a,b)=>{ const y=net(); cell(t,{A:[a],B:[b],Y:[y]},{A:'input',B:'input',Y:'output'}); return y; };
  const un =(t,a)  =>{ const y=net(); cell(t,{A:[a],Y:[y]},{A:'input',Y:'output'}); return y; };
  const name=(nm,bits)=>bits.forEach((b,i)=>netnames[bits.length>1?nm+'['+i+']':nm]={hide_name:0,bits:[b]});
  return {
    net, cells, ports, netnames,
    AND:(a,b)=>bin('$_AND_',a,b), OR:(a,b)=>bin('$_OR_',a,b), XOR:(a,b)=>bin('$_XOR_',a,b),
    NOR:(a,b)=>bin('$_NOR_',a,b), XNOR:(a,b)=>bin('$_XNOR_',a,b), NAND:(a,b)=>bin('$_NAND_',a,b),
    NOT:a=>un('$_NOT_',a),
    dff:(clk,d,q)=>cell('$_DFF_P_',{C:[clk],D:[d],Q:[q]},{C:'input',D:'input',Q:'output'}),
    bus(k){ const b=[]; for(let i=0;i<k;i++) b.push(net()); return b; },
    inPort(nm,bits){ ports[nm]={direction:'input',bits}; name(nm,bits); },
    outPort(nm,bits){ ports[nm]={direction:'output',bits}; name(nm,bits); },
    done(nm){ return {creator:'gen',modules:{[nm]:{attributes:{top:'00000000000000000000000000000001'},
      ports,cells,netnames}}}; }
  };
}

/* ---- n x n unsigned array multiplier (no constants: top bit uses a half add) ---- */
function genMult(n){
  const B=builder(), a=B.bus(n), b=B.bus(n);
  B.inPort('a',a); B.inPort('b',b);
  const pp=[]; for(let i=0;i<n;i++){ pp[i]=[]; for(let j=0;j<n;j++) pp[i][j]=B.AND(a[j],b[i]); }
  // Iteratively: res[i] = low bit of (remainder + partial-product row); the
  // remainder is shifted ONCE per step (in the acc update), not twice.
  const res=[];
  res[0]=pp[0][0];
  let acc=pp[0].slice(1);                 // remainder after taking bit 0
  for(let i=1;i<n;i++){
    const row=pp[i], s=[]; let carry=null; const m=acc.length;
    for(let k=0;k<n;k++){
      const A = k<m ? acc[k] : null, Bb = row[k];
      if(A===null){
        if(carry===null){ s[k]=Bb; }
        else { s[k]=B.XOR(Bb,carry); carry=B.AND(Bb,carry); }
      } else if(carry===null){ s[k]=B.XOR(A,Bb); carry=B.AND(A,Bb); }
      else { const t=B.XOR(A,Bb); s[k]=B.XOR(t,carry); carry=B.OR(B.AND(A,Bb),B.AND(t,carry)); }
    }
    res[i]=s[0];
    acc=s.slice(1).concat(carry===null?[]:[carry]);
  }
  for(let k=0;k<n;k++) res[n+k]=acc[k];
  B.outPort('p',res);
  return B.done('mult'+n);
}

/* ---- n-bit barrel ROTATOR (rotate avoids needing a constant zero fill) ---- */
function genBarrel(n){
  const B=builder(), stages=Math.log2(n)|0;
  const d=B.bus(n), s=B.bus(stages);
  B.inPort('d',d); B.inPort('s',s);
  let cur=d.slice();
  for(let k=0;k<stages;k++){
    const sh=1<<k, ns=B.NOT(s[k]), out=[];
    for(let i=0;i<n;i++){
      const straight=cur[i], rotated=cur[(i-sh+n)%n];
      out[i]=B.OR(B.AND(straight,ns), B.AND(rotated,s[k]));   // 2:1 mux
    }
    cur=out;
  }
  B.outPort('q',cur);
  return B.done('barrel'+n);
}

/* ---- parallel CRC-16/CCITT (x^16+x^12+x^5+1), W data bits per clock ----
   The next-state equations are derived by running the serial CRC symbolically
   over GF(2): each state bit becomes an XOR of a subset of {state, data}. ---- */
function genCRC(W){
  const B=builder(), N=16;
  const clk=B.net(); B.inPort('clk',[clk]);
  const din=B.bus(W); B.inPort('din',din);
  const q=B.bus(N);

  // symbolic: Set of source ids, 0..15 = q[i], 16.. = din[t]
  let sym=[]; for(let i=0;i<N;i++) sym[i]=new Set([i]);
  const xorSet=(x,y)=>{ const r=new Set(x); for(const v of y){ r.has(v)?r.delete(v):r.add(v); } return r; };
  for(let t=0;t<W;t++){
    const fb=xorSet(sym[N-1], new Set([16+t]));
    const nx=[];
    nx[0]=fb;
    for(let i=1;i<N;i++) nx[i]= (i===5||i===12) ? xorSet(sym[i-1],fb) : new Set(sym[i-1]);
    sym=nx;
  }
  const src=id=> id<N ? q[id] : din[id-N];
  const tree=set=>{ let list=[...set].sort((x,y)=>x-y).map(src);
    if(list.length===0) return null;
    while(list.length>1){ const nxt=[];
      for(let i=0;i<list.length;i+=2) nxt.push(i+1<list.length ? B.XOR(list[i],list[i+1]) : list[i]);
      list=nxt; }
    return list[0]; };
  for(let i=0;i<N;i++){
    const d=tree(sym[i]);
    B.dff(clk, d===null?q[i]:d, q[i]);
  }
  B.outPort('crc',q);
  return B.done('crc'+N+'p'+W);
}

/* ---- n-bit magnitude comparator (MSB-first chain, no constants) ---- */
function genCmp(n){
  const B=builder(), a=B.bus(n), b=B.bus(n);
  B.inPort('a',a); B.inPort('b',b);
  let e=B.XNOR(a[n-1],b[n-1]);
  let g=B.AND(a[n-1],B.NOT(b[n-1]));
  for(let i=n-2;i>=0;i--){
    const gi=B.AND(e, B.AND(a[i], B.NOT(b[i])));
    g=B.OR(g,gi);
    e=B.AND(e, B.XNOR(a[i],b[i]));
  }
  const lt=B.NOR(g,e);
  B.outPort('gt',[g]); B.outPort('eq',[e]); B.outPort('lt',[lt]);
  return B.done('cmp'+n);
}

if(typeof module!=='undefined') module.exports={genMult,genBarrel,genCRC,genCmp};
