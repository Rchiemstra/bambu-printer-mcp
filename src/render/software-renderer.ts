import { PNG } from "pngjs";
import { SecureGcode3mfReader } from "../3mf/gcode-3mf-reader.js";
import { parseGcodeStream } from "../3mf/gcode-parser.js";
import type { Bounds3, MotionPrimitive, SupportWarning, Vec3 } from "../3mf/gcode-types.js";
import { SupportMetricsCollector } from "../support/support-metrics.js";
import { SupportToolError, throwIfCancelled } from "../support/support-error.js";
import { createCamera, projectPoint, type PreviewView } from "./camera.js";

export interface RenderWorkerInput {
  three_mf_path: string;
  plate_index: number;
  deadline_ms: number;
  view: PreviewView;
  show_model: boolean;
  show_support: boolean;
  show_support_interface: boolean;
  show_travel: boolean;
  layer_start?: number;
  layer_end?: number;
  width: number;
  height: number;
  background: "solid" | "transparent";
  background_color: string;
}

export interface RenderWorkerResult {
  png: Buffer;
  summary: {
    camera: ReturnType<typeof createCamera>;
    fit_bounds: Bounds3;
    visible_roles: string[];
    dimensions: { width: number; height: number };
    encoded_byte_count: number;
    support_summary: { support_present: boolean | null; layer_count: number; segment_count: number; path_length_mm: number };
    parser: { complete: boolean; line_count: number; motion_count: number };
    warnings: SupportWarning[];
  };
}

const COLORS:Record<string,[number,number,number,number]>={
  support_body:[60,230,80,255],support_transition:[35,170,70,255],support_interface:[15,110,45,255],
  model:[60,145,235,255],adhesion:[235,160,45,255],prime_tower:[170,90,220,255],flush:[220,90,150,255],
  custom:[230,90,50,255],unknown:[180,180,180,255],travel:[130,130,130,170],wipe:[110,110,110,180],retract:[100,100,100,180],
};

function visible(primitive:MotionPrimitive,input:RenderWorkerInput):boolean{
  const layer=primitive.layerIndex;
  if(input.layer_start!==undefined&&(layer===null||layer<input.layer_start))return false;
  if(input.layer_end!==undefined&&(layer===null||layer>input.layer_end))return false;
  if(primitive.category==="support_body"||primitive.category==="support_transition")return input.show_support&&primitive.positiveEDeltaMm>0;
  if(primitive.category==="support_interface")return input.show_support_interface&&primitive.positiveEDeltaMm>0;
  if(primitive.category==="travel")return input.show_travel;
  return input.show_model&&primitive.positiveEDeltaMm>0;
}

function include(target:Bounds3|null,incoming:Bounds3,expand:number):Bounds3{
  const value={min:{x:incoming.min.x-expand,y:incoming.min.y-expand,z:incoming.min.z-expand},max:{x:incoming.max.x+expand,y:incoming.max.y+expand,z:incoming.max.z+expand}};
  if(!target)return value;
  target.min.x=Math.min(target.min.x,value.min.x);target.min.y=Math.min(target.min.y,value.min.y);target.min.z=Math.min(target.min.z,value.min.z);
  target.max.x=Math.max(target.max.x,value.max.x);target.max.y=Math.max(target.max.y,value.max.y);target.max.z=Math.max(target.max.z,value.max.z);return target;
}

function colorFromHex(hex:string):[number,number,number,number]{
  const match=/^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if(!match)throw new SupportToolError("INVALID_BACKGROUND_COLOR","background_color must be #RRGGBB or #RRGGBBAA.");
  return [parseInt(match[1].slice(0,2),16),parseInt(match[1].slice(2,4),16),parseInt(match[1].slice(4,6),16),match[2]?parseInt(match[2],16):255];
}

function primitivePoints(primitive:MotionPrimitive,pixelsPerMm:number):Vec3[]{
  if(primitive.kind==="line"||!primitive.center||primitive.sweepRadians===undefined)return[primitive.start,primitive.end];
  const radius=Math.hypot(primitive.start.x-primitive.center.x,primitive.start.y-primitive.center.y);
  const arcPixels=Math.max(1,radius*Math.abs(primitive.sweepRadians)*pixelsPerMm);
  const count=Math.min(4096,Math.max(2,Math.ceil(arcPixels/1.5)));
  const startAngle=Math.atan2(primitive.start.y-primitive.center.y,primitive.start.x-primitive.center.x);
  const points:Vec3[]=[];
  for(let index=0;index<=count;index++){
    const t=index/count,angle=startAngle+primitive.sweepRadians*t;
    points.push({x:primitive.center.x+radius*Math.cos(angle),y:primitive.center.y+radius*Math.sin(angle),z:primitive.start.z+(primitive.end.z-primitive.start.z)*t});
  }
  return points;
}

function rasterLine(data:Buffer,depth:Float64Array,width:number,height:number,a:{x:number;y:number;depth:number},b:{x:number;y:number;depth:number},radius:number,color:[number,number,number,number]):void{
  const minX=Math.max(0,Math.floor(Math.min(a.x,b.x)-radius-1)),maxX=Math.min(width-1,Math.ceil(Math.max(a.x,b.x)+radius+1));
  const minY=Math.max(0,Math.floor(Math.min(a.y,b.y)-radius-1)),maxY=Math.min(height-1,Math.ceil(Math.max(a.y,b.y)+radius+1));
  const dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
    const t=len2===0?0:Math.max(0,Math.min(1,((x+0.5-a.x)*dx+(y+0.5-a.y)*dy)/len2));
    const px=a.x+dx*t,py=a.y+dy*t,d=Math.hypot(x+0.5-px,y+0.5-py);
    const coverage=Math.max(0,Math.min(1,radius+0.5-d));if(coverage<=0)continue;
    const z=a.depth+(b.depth-a.depth)*t,index=y*width+x;if(z<depth[index]-1e-12)continue;depth[index]=z;
    const offset=index*4,alpha=(color[3]/255)*coverage,inv=1-alpha;
    data[offset]=Math.round(color[0]*alpha+data[offset]*inv);data[offset+1]=Math.round(color[1]*alpha+data[offset+1]*inv);data[offset+2]=Math.round(color[2]*alpha+data[offset+2]*inv);data[offset+3]=Math.round((alpha+(data[offset+3]/255)*inv)*255);
  }
}

export async function renderPreviewInWorker(input:RenderWorkerInput):Promise<RenderWorkerResult>{
  throwIfCancelled(undefined,input.deadline_ms);
  const reader=await SecureGcode3mfReader.open(input.three_mf_path,input.plate_index,{deadlineMs:input.deadline_ms});
  let bounds:Bounds3|null=null;const roles=new Set<string>();const collector=new SupportMetricsCollector();
  const first=parseGcodeStream(await reader.openGcodeStream(undefined,input.deadline_ms),{deadlineMs:input.deadline_ms,onPrimitive:(primitive)=>{
    collector.accept(primitive);if(!visible(primitive,input))return;roles.add(primitive.role??primitive.category);bounds=include(bounds,primitive.bounds,(primitive.widthMm??0)/2);
  }});
  const parsed=await first;if(!bounds)throw new SupportToolError("NO_VISIBLE_TOOLPATHS","No toolpaths are visible with the requested role and layer filters.");
  const metrics=collector.finish(parsed);const camera=createCamera(input.view,bounds,input.width,input.height);
  const png=new PNG({width:input.width,height:input.height});const bg=colorFromHex(input.background_color);
  for(let i=0;i<input.width*input.height;i++){const o=i*4;png.data[o]=bg[0];png.data[o+1]=bg[1];png.data[o+2]=bg[2];png.data[o+3]=input.background==="transparent"?0:bg[3];}
  const depth=new Float64Array(input.width*input.height);depth.fill(Number.NEGATIVE_INFINITY);let commands=0;
  await parseGcodeStream(await reader.openGcodeStream(undefined,input.deadline_ms),{deadlineMs:input.deadline_ms,onPrimitive:(primitive)=>{
    if(!visible(primitive,input))return;if((++commands&0x1fff)===0)throwIfCancelled(undefined,input.deadline_ms);
    const points=primitivePoints(primitive,camera.pixels_per_mm);const radius=primitive.category==="travel"?0.55:Math.max(0.65,(primitive.widthMm??0.4)*camera.pixels_per_mm/2);const color=COLORS[primitive.category]??COLORS.unknown;
    for(let i=1;i<points.length;i++)rasterLine(png.data,depth,input.width,input.height,projectPoint(points[i-1],camera,input.width,input.height),projectPoint(points[i],camera,input.width,input.height),radius,color);
  }});
  const encoded=PNG.sync.write(png,{colorType:6,inputColorType:6,inputHasAlpha:true,deflateLevel:9,deflateStrategy:3,filterType:4});
  if(encoded.length>8*1024*1024)throw new SupportToolError("RENDER_LIMIT_EXCEEDED","Encoded PNG exceeds the 8 MiB limit.");
  return{png:encoded,summary:{camera,fit_bounds:bounds,visible_roles:[...roles].sort(),dimensions:{width:input.width,height:input.height},encoded_byte_count:encoded.length,support_summary:{support_present:metrics.support_present,layer_count:metrics.support_combined.layer_count,segment_count:metrics.support_combined.segment_count,path_length_mm:metrics.support_combined.path_length_mm},parser:{complete:parsed.completeness.complete,line_count:parsed.lineCount,motion_count:parsed.motionCount},warnings:metrics.warnings}};
}
