import type { Bounds3, Vec3 } from "../3mf/gcode-types.js";
import { SupportToolError } from "../support/support-error.js";

export type PreviewView = "isometric" | "front" | "rear" | "left" | "right" | "top" | "bottom";

export interface CameraProjection {
  projection: "orthographic";
  direction: Vec3;
  up: Vec3;
  right: Vec3;
  target: Vec3;
  fit_bounds: Bounds3;
  margin_fraction: number;
  pixels_per_mm: number;
}

const DIRECTIONS: Record<PreviewView, Vec3> = {
  isometric: { x: 1, y: -1, z: 1 },
  front: { x: 0, y: -1, z: 0 },
  rear: { x: 0, y: 1, z: 0 },
  left: { x: -1, y: 0, z: 0 },
  right: { x: 1, y: 0, z: 0 },
  top: { x: 0, y: 0, z: 1 },
  bottom: { x: 0, y: 0, z: -1 },
};

function dot(a: Vec3, b: Vec3): number { return a.x*b.x+a.y*b.y+a.z*b.z; }
function cross(a: Vec3, b: Vec3): Vec3 { return { x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x }; }
function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value.x,value.y,value.z);
  if (!(length > 0)) throw new SupportToolError("INVALID_CAMERA", "Camera vector must be non-zero.");
  return { x:value.x/length,y:value.y/length,z:value.z/length };
}

export function createCamera(view: PreviewView, bounds: Bounds3, width: number, height: number): CameraProjection {
  const direction = normalize(DIRECTIONS[view]);
  const referenceUp: Vec3 = view === "top" ? {x:0,y:1,z:0} : view === "bottom" ? {x:0,y:-1,z:0} : {x:0,y:0,z:1};
  const right = normalize(cross(referenceUp,direction));
  const up = normalize(cross(direction,right));
  const target={x:(bounds.min.x+bounds.max.x)/2,y:(bounds.min.y+bounds.max.y)/2,z:(bounds.min.z+bounds.max.z)/2};
  const corners:Vec3[]=[];
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])corners.push({x,y,z});
  const projected=corners.map((point)=>({x:dot({x:point.x-target.x,y:point.y-target.y,z:point.z-target.z},right),y:dot({x:point.x-target.x,y:point.y-target.y,z:point.z-target.z},up)}));
  const rangeX=Math.max(1e-6,Math.max(...projected.map(p=>p.x))-Math.min(...projected.map(p=>p.x)));
  const rangeY=Math.max(1e-6,Math.max(...projected.map(p=>p.y))-Math.min(...projected.map(p=>p.y)));
  const pixelsPerMm=Math.min(width*0.9/rangeX,height*0.9/rangeY);
  return {projection:"orthographic",direction,up,right,target,fit_bounds:bounds,margin_fraction:0.05,pixels_per_mm:pixelsPerMm};
}

export function projectPoint(point:Vec3,camera:CameraProjection,width:number,height:number):{x:number;y:number;depth:number}{
  const relative={x:point.x-camera.target.x,y:point.y-camera.target.y,z:point.z-camera.target.z};
  return {x:width/2+dot(relative,camera.right)*camera.pixels_per_mm,y:height/2-dot(relative,camera.up)*camera.pixels_per_mm,depth:dot(relative,camera.direction)};
}
