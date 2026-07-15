import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseGcodeStream } from "../dist/3mf/gcode-parser.js";
import { SecureGcode3mfReader } from "../dist/3mf/gcode-3mf-reader.js";
import { parse3mfTriangles } from "../dist/support/mesh-analysis.js";
import { analyze3mfSupports } from "../dist/support/support-analyzer.js";
import { render3mfPreview } from "../dist/render/support-preview.js";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const FIXTURES=path.join(ROOT,"tests","fixtures","support");
const SERVER=path.join(ROOT,"dist","index.js");
const CONTENT_TYPES='<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const MODEL='<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0.2"/><vertex x="20" y="0" z="0.2"/><vertex x="0" y="20" z="0.2"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';

async function fixture(name){return fs.readFile(path.join(FIXTURES,name),"utf8");}

async function make3mf({gcode,supportType="normal(auto)",enableSupport="1",model=MODEL,md5=true,mutateZip}={}){
  gcode ??= await fixture("normal-support.gcode");
  const zip=new JSZip();zip.file("[Content_Types].xml",CONTENT_TYPES);zip.file("3D/3dmodel.model",model);zip.file("Metadata/plate_1.gcode",gcode);
  if(md5)zip.file("Metadata/plate_1.gcode.md5",createHash("md5").update(Buffer.from(gcode)).digest("hex"));
  zip.file("Metadata/project_settings.config",JSON.stringify({enable_support:enableSupport,support_type:supportType,filament_diameter:["1.75"],filament_density:["1.24"]}));
  zip.file("Metadata/plate_1.json",JSON.stringify({bbox_objects:[{id:1}]}));if(mutateZip)mutateZip(zip);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"support-3mf-")),file=path.join(dir,"fixture.gcode.3mf");await fs.writeFile(file,await zip.generateAsync({type:"nodebuffer",platform:"UNIX",compression:"DEFLATE",compressionOptions:{level:6}}));return{file,dir};
}

async function cleanup(item){await fs.rm(item.dir,{recursive:true,force:true});}

function patchAllAscii(buffer,from,to){assert.equal(Buffer.byteLength(from),Buffer.byteLength(to));const output=Buffer.from(buffer);let offset=0;while((offset=output.indexOf(from,offset,"ascii"))>=0){output.write(to,offset,"ascii");offset+=to.length;}return output;}

function markZipEncrypted(buffer){const output=Buffer.from(buffer);for(let offset=0;offset<=output.length-4;offset+=1){const signature=output.readUInt32LE(offset);if(signature===0x04034b50&&offset+8<output.length)output.writeUInt16LE(output.readUInt16LE(offset+6)|1,offset+6);if(signature===0x02014b50&&offset+10<output.length)output.writeUInt16LE(output.readUInt16LE(offset+8)|1,offset+8);}return output;}

test("parser handles independent positioning/E modes, G92, retracts, and non-spatial E",async()=>{
  const primitives=[];const text=`G90\nM83\n; CHANGE_LAYER\n; FEATURE: Support\n; LINE_WIDTH: 0.4\nG1 X10 E1\nG1 E-0.5\nG1 E0.5\nG91\nG1 X5 E1\nM82\nG92 E0\nG1 X5 E2\n`;
  const summary=await parseGcodeStream(Readable.from([text]),{onPrimitive:p=>primitives.push(p)});
  const extrusion=primitives.filter(p=>p.positiveEDeltaMm>0);assert.deepEqual(extrusion.map(p=>p.positiveEDeltaMm),[1,1,2]);assert.deepEqual(extrusion.map(p=>p.pathLengthMm),[10,5,5]);assert.equal(summary.completeness.featureTagsPresent,true);
});

test("parser calculates I/J helical arcs and Bambu P1 full circles",async()=>{
  const primitives=[];const text=`G90\nM83\n; CHANGE_LAYER\n; FEATURE: Support\nG1 X1 Y0 Z0\nG3 X0 Y1 Z1 I-1 J0 E1\nG2 X0 Y1 I0 J-1 P1 E2\n`;
  await parseGcodeStream(Readable.from([text]),{onPrimitive:p=>primitives.push(p)});const arcs=primitives.filter(p=>p.kind==="arc");
  assert.equal(arcs.length,2);assert.ok(Math.abs(arcs[0].pathLengthMm-Math.hypot(Math.PI/2,1))<1e-9);assert.ok(Math.abs(arcs[1].pathLengthMm-Math.PI*2)<1e-9);assert.equal(arcs[1].fullCircle,true);assert.ok(arcs[1].bounds.min.x<=-1&&arcs[1].bounds.max.x>=1);
});

test("parser rejects unsupported extrusion planes and R arcs",async()=>{
  await assert.rejects(()=>parseGcodeStream(Readable.from([`M83\nG18\n; FEATURE: Support\nG2 X1 Z1 I1 E1\n`])),error=>error.code==="UNSUPPORTED_EXTRUSION_ARC");
  await assert.rejects(()=>parseGcodeStream(Readable.from([`M83\n; FEATURE: Support\nG2 X1 Y1 R1 E1\n`])),error=>error.code==="UNSUPPORTED_EXTRUSION_ARC");
});

test("parser rejects malformed numbers, bounds unknown roles, and classifies wipe/custom regions",async()=>{
  await assert.rejects(()=>parseGcodeStream(Readable.from([`G1 XNaN E1\n`])),error=>error.code==="MALFORMED_GCODE_NUMBER");
  await assert.rejects(()=>parseGcodeStream(Readable.from([`G1 X1000001\n`])),error=>error.code==="COORDINATE_LIMIT_EXCEEDED");
  const primitives=[];const result=await parseGcodeStream(Readable.from([`; CHANGE_LAYER\n; FEATURE: Future role\nM83\nG1 X1 E1\n; WIPE_START\nG1 X2 E1\n; WIPE_END\n; FEATURE: Custom\nG1 X3 E1\nM900 strange custom command\n`]),{onPrimitive:item=>primitives.push(item)});
  assert.deepEqual(primitives.map(item=>item.category),["unknown","wipe","custom"]);assert.deepEqual(result.rolesSeen,["Custom","Future role"]);
});

test("analysis classifies support roles, metrics, material, and mesh heuristics",async()=>{
  const archive=await make3mf();try{const result=await analyze3mfSupports({three_mf_path:archive.file,sensitive_regions:[{id:"opening",semantic:"screw hole",kind:"box",center:{x:5,y:0,z:0.2},size:{x:3,y:3,z:3}}]});
    assert.equal(result.support_present,true);assert.equal(result.support_body.segment_count,1);assert.equal(result.support_transition.segment_count,1);assert.equal(result.support_interface.segment_count,1);assert.equal(result.support_combined.layer_count,2);assert.equal(result.support_combined.commanded_filament_length_mm,2);assert.ok(Math.abs(result.support_combined.commanded_volume_mm3-4.81056375)<1e-7);assert.equal(result.mesh_aware,true);assert.equal(result.mesh_triangle_count,1);assert.ok(result.contact_regions.length>0);assert.ok(result.blocked_openings.some(item=>item.annotation_id==="opening"));assert.equal(result.metric_provenance.contact_regions,"mesh_heuristic");
  }finally{await cleanup(archive);}
});

test("no-support is false only with feature tags; missing tags is null",async()=>{
  const tagged=await make3mf({gcode:await fixture("no-support.gcode"),enableSupport:"0"});const untagged=await make3mf({gcode:"G90\nM83\nG1 X10 E1\n",enableSupport:"0"});
  try{assert.equal((await analyze3mfSupports({three_mf_path:tagged.file,mesh_analysis:false})).support_present,false);const result=await analyze3mfSupports({three_mf_path:untagged.file,mesh_analysis:false});assert.equal(result.support_present,null);assert.ok(result.warnings.some(w=>w.code==="FEATURE_TAGS_MISSING"));}finally{await cleanup(tagged);await cleanup(untagged);}
});

test("multi-material support is separated by active tool",async()=>{
  const archive=await make3mf({gcode:await fixture("multi-extruder.gcode")});try{const result=await analyze3mfSupports({three_mf_path:archive.file,mesh_analysis:false});assert.deepEqual(result.per_filament.map(item=>item.tool_index),[0,1]);assert.deepEqual(result.per_filament.map(item=>item.commanded_filament_length_mm),[0.4,0.6]);assert.equal(result.per_filament[1].filament_type,"PVA");}finally{await cleanup(archive);}
});

test("3MF mesh parser resolves component and build transforms with plate membership",async()=>{
  const xml=Buffer.from(`<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 1 0 0"/></components></object><object id="2"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object><object id="3"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/><item objectid="3"/></build></model>`);
  const triangles=await parse3mfTriangles(xml,new Set([1]));assert.equal(triangles.length,1);assert.equal(triangles[0].a.x,11);assert.equal(triangles[0].b.x,12);
});

test("archive reader rejects checksum mismatches, case-folded duplicates, symlinks, bombs, and limits",async()=>{
  const mismatch=await make3mf({md5:false,mutateZip:zip=>zip.file("Metadata/plate_1.gcode.md5","00000000000000000000000000000000")});
  await assert.rejects(()=>SecureGcode3mfReader.open(mismatch.file),error=>error.code==="GCODE_CHECKSUM_MISMATCH");await cleanup(mismatch);
  const duplicate=await make3mf({mutateZip:zip=>zip.file("metadata/PLATE_1.gcode","G1 X0")});await assert.rejects(()=>SecureGcode3mfReader.open(duplicate.file),error=>error.code==="DUPLICATE_ZIP_ENTRY");await cleanup(duplicate);
  const symlink=await make3mf({mutateZip:zip=>zip.file("Metadata/link","target",{unixPermissions:0o120777})});await assert.rejects(()=>SecureGcode3mfReader.open(symlink.file),error=>error.code==="SYMLINK_ZIP_ENTRY");await cleanup(symlink);
  const bomb=await make3mf({mutateZip:zip=>zip.file("Metadata/bomb.txt","A".repeat(2_000_000))});await assert.rejects(()=>SecureGcode3mfReader.open(bomb.file),error=>error.code==="COMPRESSION_RATIO_EXCEEDED");await cleanup(bomb);
  const limited=await make3mf();await assert.rejects(()=>SecureGcode3mfReader.open(limited.file,0,{limits:{maxEntries:2}}),error=>error.code==="ARCHIVE_ENTRY_LIMIT_EXCEEDED");await cleanup(limited);
});

test("archive reader rejects traversal, encryption, malformed checksum, oversized metadata, and wrong plates",async()=>{
  const traversal=await make3mf({mutateZip:zip=>zip.file("Metadata/bad","x")});let bytes=await fs.readFile(traversal.file);bytes=patchAllAscii(bytes,"Metadata/bad","../evil/path");await fs.writeFile(traversal.file,bytes);await assert.rejects(()=>SecureGcode3mfReader.open(traversal.file),error=>error.code==="UNSAFE_ZIP_ENTRY");await cleanup(traversal);
  const encrypted=await make3mf();await fs.writeFile(encrypted.file,markZipEncrypted(await fs.readFile(encrypted.file)));await assert.rejects(()=>SecureGcode3mfReader.open(encrypted.file),error=>error.code==="ENCRYPTED_ZIP_ENTRY"||error.code==="INVALID_ZIP_ARCHIVE");await cleanup(encrypted);
  const malformed=await make3mf({md5:false,mutateZip:zip=>zip.file("Metadata/plate_1.gcode.md5","not-md5")});await assert.rejects(()=>SecureGcode3mfReader.open(malformed.file),error=>error.code==="MALFORMED_GCODE_CHECKSUM");await cleanup(malformed);
  const metadata=await make3mf();await assert.rejects(()=>SecureGcode3mfReader.open(metadata.file,0,{limits:{maxMetadataBytes:4}}),error=>error.code==="METADATA_LIMIT_EXCEEDED");await cleanup(metadata);
  const wrong=await make3mf({mutateZip:zip=>{zip.remove("Metadata/plate_1.gcode");zip.remove("Metadata/plate_1.gcode.md5");zip.file("Metadata/plate_2.gcode","G1 X0");}});await assert.rejects(()=>SecureGcode3mfReader.open(wrong.file),error=>error.code==="PLATE_GCODE_NOT_FOUND");await cleanup(wrong);
  const badJson=await make3mf({mutateZip:zip=>zip.file("Metadata/project_settings.config","{")});try{const result=await analyze3mfSupports({three_mf_path:badJson.file,mesh_analysis:false});assert.ok(result.warnings.some(w=>w.code==="MALFORMED_3MF_METADATA"));}finally{await cleanup(badJson);}
});

test("analysis honors cancellation and parser line/motion limits",async()=>{
  const archive=await make3mf();try{const controller=new AbortController();controller.abort();await assert.rejects(()=>analyze3mfSupports({three_mf_path:archive.file},{signal:controller.signal}),error=>error.code==="CANCELLED");await assert.rejects(()=>analyze3mfSupports({three_mf_path:archive.file},{parserLimits:{maxLines:2}}),error=>error.code==="GCODE_LINE_COUNT_EXCEEDED");}finally{await cleanup(archive);}
});

test("renderer is deterministic across views, toggles, layers, and backgrounds",async()=>{
  const archive=await make3mf();try{const common={three_mf_path:archive.file,width:160,height:120,view:"isometric"};const first=await render3mfPreview(common);const second=await render3mfPreview(common);assert.deepEqual(first.png,second.png);assert.equal(createHash("sha256").update(first.png).digest("hex"),"d8f6209a23cfcb37b667dc1659eaaa74c80c4ab06717c905487bde3174b30fc5");assert.deepEqual([...first.png.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(first.summary.dimensions.width,160);assert.equal(first.summary.image_path,null);assert.ok(!JSON.stringify(first.summary).includes(first.png.toString("base64")));
    for(const view of ["front","rear","left","right","top","bottom"]){const result=await render3mfPreview({...common,view,background:"transparent",show_model:false});assert.equal(result.summary.camera.projection,"orthographic");assert.equal(result.png.readUInt32BE(16),160);assert.equal(result.png.readUInt32BE(20),120);}
    const filtered=await render3mfPreview({...common,layer_start:1,layer_end:1,show_model:false,show_support:false,show_support_interface:true});assert.deepEqual(filtered.summary.visible_roles,["Support interface"]);
  }finally{await cleanup(archive);}
});

test("renderer validates dimensions and cancellation",async()=>{
  const archive=await make3mf();try{await assert.rejects(()=>render3mfPreview({three_mf_path:archive.file,width:2048,height:2048}),error=>error.code==="INVALID_IMAGE_DIMENSIONS");const controller=new AbortController();controller.abort();await assert.rejects(()=>render3mfPreview({three_mf_path:archive.file,width:64,height:64},controller.signal),error=>error.code==="CANCELLED");}finally{await cleanup(archive);}
});

test("renderer saves atomically and rejects overwrite and symlink leaves",async(t)=>{
  if(process.platform==="win32")t.skip("symlink creation requires platform privileges; exercised in Docker Linux");const archive=await make3mf();const out=path.join(archive.dir,"preview.png");try{const result=await render3mfPreview({three_mf_path:archive.file,width:80,height:80,save_path:out});assert.equal(result.summary.image_path,out);await assert.rejects(()=>render3mfPreview({three_mf_path:archive.file,width:80,height:80,save_path:out}),error=>error.code==="SAVE_PATH_EXISTS");await fs.unlink(out);await fs.symlink(path.join(archive.dir,"elsewhere.png"),out);await assert.rejects(()=>render3mfPreview({three_mf_path:archive.file,width:80,height:80,save_path:out,overwrite:true}),error=>error.code==="UNSAFE_SAVE_PATH");}finally{await cleanup(archive);}
});

test("MCP tools return structured analysis and mixed text/image preview without BAMBU_MODEL",async(t)=>{
  const archive=await make3mf();const transport=new StdioClientTransport({command:process.execPath,args:[SERVER],env:{...process.env,MCP_TRANSPORT:"stdio",BAMBU_MODEL:""},stderr:"pipe"});const client=new Client({name:"support-test",version:"1"});t.after(async()=>{await transport.close().catch(()=>undefined);await cleanup(archive);});await client.connect(transport);
  const listed=await client.listTools();assert.ok(listed.tools.some(tool=>tool.name==="analyze_3mf_supports"));assert.ok(listed.tools.some(tool=>tool.name==="render_3mf_preview"));
  const analysis=await client.callTool({name:"analyze_3mf_supports",arguments:{three_mf_path:archive.file,mesh_analysis:false}});assert.equal(analysis.isError,undefined);assert.equal(analysis.structuredContent.support_present,true);assert.equal(analysis.content[0].type,"text");
  const preview=await client.callTool({name:"render_3mf_preview",arguments:{three_mf_path:archive.file,width:96,height:64}});assert.equal(preview.content[0].type,"text");assert.equal(preview.content[1].type,"image");assert.equal(preview.content[1].mimeType,"image/png");assert.equal(preview.structuredContent.encoded_byte_count,Buffer.from(preview.content[1].data,"base64").length);assert.ok(!preview.content[0].text.includes(preview.content[1].data));
});
