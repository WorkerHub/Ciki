import fs from "node:fs"
import { launch } from "./lib.mjs"
const browser = await launch()
const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage()
const f = (p) => "data:image/png;base64," + fs.readFileSync(p).toString("base64")
const out = await page.evaluate(async ([a,b]) => {
  const load = (src) => new Promise((res)=>{const i=new Image();i.onload=()=>res(i);i.src=src})
  const [ia,ib] = await Promise.all([load(a),load(b)])
  const px = (img)=>{const c=document.createElement("canvas");c.width=img.width;c.height=img.height;const x=c.getContext("2d");x.drawImage(img,0,0);return x.getImageData(0,0,img.width,img.height).data}
  const da=px(ia), db=px(ib), W=ia.width
  const res=[]
  for (const y of [15,16,30,31,32,33]) {
    for (const x of [283,284,285,286]) {
      const j=(y*W+x)*4
      res.push({x,y,a:`rgb(${da[j]},${da[j+1]},${da[j+2]})`,b:`rgb(${db[j]},${db[j+1]},${db[j+2]})`})
    }
  }
  return res
}, [f("/tmp/qa/shots/cmp-new-vs-old-nova-light-new.png"), f("/tmp/qa/shots/cmp-new-vs-old-nova-light-old.png")])
console.log(JSON.stringify(out))
await browser.close()
