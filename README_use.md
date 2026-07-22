# circuit-background

An animated background made of **real gate-level schematics**. Each design is a
synthesised netlist that is drawn as a schematic and then *simulated live in the
browser* — every wire is coloured by its actual logic value, so the motion you
see is the circuit computing, not a decorative loop.

Six designs rotate through three parallax planes:

| design | gates | flip-flops | notes |
|---|---|---|---|
| 16-bit ALU | 215 | — | add / sub / and / or with control decode |
| 16-bit barrel rotator | 196 | — | four mux stages |
| 6×6 array multiplier | 168 | — | triangular partial-product array |
| parallel CRC-16 | 108 | 16 | CCITT polynomial, 12 bits/clock, XOR trees |
| 16-bit magnitude comparator | 94 | — | MSB-first gt/eq/lt chain |
| LFSR + accumulator | 80 | 32 | self-clocking, no inputs |

The two sequential designs clock themselves; the combinational ones get fresh
random stimulus each tick. Background planes show the state from 1–2 cycles ago,
so the planes don't move in lockstep.

## Files

```
circuit-background/
├── index.html              demo page — copy the two tags into your own page
├── circuit-background.js   the whole thing (no dependencies, no build step)
├── circuit-background.css  layer + net-colour styles
├── schematics/
│   ├── manifest.json       list of designs
│   ├── <design>.svg        the drawing (nets tagged with data-net)
│   └── <design>.sim.json   the simulation model for that drawing
└── tools/                  Node scripts that generated the schematics
```

## Use it

Commit the folder, then add two tags to your page:

```html
<link rel="stylesheet" href="/circuit-background/circuit-background.css">
<script src="/circuit-background/circuit-background.js" defer></script>
```

Two things to get right:

1. **Point it at the assets.** The script defaults to `schematics/` relative to
   the page. If your page lives elsewhere, set the base path before the script
   loads:

   ```html
   <script>window.CIRCUIT_BG = { base: '/circuit-background/schematics/' };</script>
   ```

2. **Put your content above it.** The background sits at `z-index: 0`, so give
   your content a stacking context — either add `class="cbg-content"` to your
   main wrapper, or in your own CSS:

   ```css
   main, header, footer { position: relative; z-index: 1; }
   ```

It must be served over http(s) — GitHub Pages is fine. Opening `index.html`
straight off disk will fail, because the browser blocks `fetch` on `file://`.
To preview locally:

```bash
cd circuit-background && python3 -m http.server 8000
# then open http://localhost:8000
```

## Configure

Set `window.CIRCUIT_BG` before the script tag. Anything you omit keeps its
default.

```js
window.CIRCUIT_BG = {
  base: 'schematics/',   // where manifest.json lives
  speed: 34,             // foreground scroll, px/sec
  tick: 900,             // ms per clock edge / new stimulus
  rotateMs: 15000,       // ms before each plane advances to the next design
  layerMs: 16,           // propagation ripple per logic level
  showHud: false,        // hide the little caption top-left
  mount: '#my-bg-div'    // mount into an existing element instead of creating one
};
```

The `layers` array controls depth. Each entry is one plane, back to front:

```js
{ cls:'far', speed:0.38, scale:0.60, anchor:'top', bleed:0.13, delay:2,
  unlit:'#08210f', lit:'#20703e', label:'#1a5232', opacity:0.60, blur:0.85 }
```

- `speed` / `scale` / `opacity` / `blur` — parallax cues, currently evenly stepped
- `anchor` — `top`, `bottom`, or `center` (with `yBias`); `bleed` runs it off the edge
- `delay` — how many simulation cycles behind this plane renders
- `unlit` / `lit` — logic-0 and logic-1 colours for this plane

Adding or removing an entry changes the number of planes; no other edits needed.

## Behaviour worth knowing

- Respects `prefers-reduced-motion`: renders one static frame, no scrolling or flicker.
- Pauses on tab-hide, so it isn't burning battery in the background.
- `pointer-events: none`, so it never intercepts clicks.
- Fails quietly: if the assets don't load, it logs a warning and the page is unaffected.
- Rebuilds on resize (debounced).

## Regenerating the schematics

`tools/` holds the Node scripts that produced everything in `schematics/`.

```bash
cd tools
TARGET_ROWS=8 node svgexport8.js alu      # writes out_alu.svg + out_alu.json
```

Valid names: `alu`, `mult`, `barrel`, `crc`, `cmp`, `seq`, `adder`. Copy the
outputs into `schematics/` as `<key>.svg` and `<key>.sim.json` and add an entry
to `manifest.json`.

Knobs in `svgexport8.js`:

- `TARGET_ROWS` (env) — wide layers are split across columns to this height;
  lower is shorter and denser
- `XS` / `YS` — column and row pitch
- `CH_STEP` / `LN_STEP` — routing track spacing in channels and lanes

### Using your own Verilog

The pipeline reads the standard Yosys JSON schema, so any synthesised design
drops in:

```bash
yosys -p 'read_verilog mydesign.v; hierarchy -auto-top; proc; flatten; opt; \
          synth; abc -g AND,NAND,OR,NOR,XOR,XNOR; opt_clean; \
          write_json mydesign.json'
```

Recognised cells are `$_AND_`, `$_NAND_`, `$_OR_`, `$_NOR_`, `$_XOR_`, `$_XNOR_`,
`$_NOT_`, `$_BUF_` and `$_DFF_P_` / `$_DFF_N_`; anything else is drawn as a plain
box. Feedback through flip-flops is handled — Q is treated as a graph source and
the return path is routed around the outside of the drawing. A port named `clk`
is deliberately not drawn, following the usual convention for a global clock.

## How it works

- **Placement** is layered by logic depth (longest path), ordered within each
  layer by barycenter. Layers wider than `TARGET_ROWS` are split across several
  columns — legal because nodes in one layer never connect to each other — which
  keeps the drawing short and dense.
- **Routing** is orthogonal: vertical runs only in channels between columns,
  horizontal runs only in lanes between rows, each net assigned its own track.
  Text labels are keep-out regions. Generated drawings have zero wires crossing
  a gate body or a label.
- **Lighting** works because each net's wires are one `<path>` tagged
  `data-net`, and each gate contributes three tagged pieces — body+output on the
  gate's output net, and each input leg on its own input net. So a gate can show
  one high input and one low input, which is the real logic state.

## Credit / licence

Yours to use however you like. Gate glyphs are drawn from scratch (IEEE
distinctive shapes); no third-party assets are bundled. If you later swap in
[netlistsvg](https://github.com/nturley/netlistsvg) symbols, keep its MIT licence
with them.
