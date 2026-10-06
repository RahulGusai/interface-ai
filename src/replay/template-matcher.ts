import{PNG}from'pngjs';
export type Match={left:number,top:number,width:number,height:number,score:number};
export function matchTemplate(image:Buffer,reference:Buffer,threshold:number):Match[]{
 const fresh=PNG.sync.read(image),crop=PNG.sync.read(reference);if(threshold<.95||threshold>1)throw Error('MATCHER_THRESHOLD_INVALID');
 if(crop.width>fresh.width||crop.height>fresh.height)throw Error('REFERENCE_DIMENSIONS_INVALID');
 let sum=0,sum2=0;for(let i=0;i<crop.data.length;i+=4)for(let c=0;c<3;c++){const v=crop.data[i+c]!;sum+=v;sum2+=v*v;}
 const n=crop.width*crop.height*3;if(Math.sqrt(sum2/n-(sum/n)**2)<5)throw Error('REFERENCE_UNINFORMATIVE');
 const budget=(1-threshold)*255*n,matches:Match[]=[];
 for(let top=0;top<=fresh.height-crop.height;top++)for(let left=0;left<=fresh.width-crop.width;left++){
  let error=0;scan:for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){const i=(y*crop.width+x)*4,j=((top+y)*fresh.width+left+x)*4;for(let c=0;c<3;c++)error+=Math.abs(crop.data[i+c]!-fresh.data[j+c]!);if(error>budget+1e-8)break scan;}
  if(error<=budget+1e-8)matches.push({left,top,width:crop.width,height:crop.height,score:1-error/(255*n)});
 }
 matches.sort((a,b)=>b.score-a.score||a.top-b.top||a.left-b.left);
 const kept:Match[]=[];for(const m of matches){if(kept.some(k=>{const w=Math.max(0,Math.min(m.left+m.width,k.left+k.width)-Math.max(m.left,k.left)),h=Math.max(0,Math.min(m.top+m.height,k.top+k.height)-Math.max(m.top,k.top));const intersection=w*h;return intersection/(m.width*m.height+k.width*k.height-intersection)>=.5;}))continue;kept.push(m);}
 return kept;
}
