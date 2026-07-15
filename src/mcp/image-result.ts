import type { RenderPreviewResult } from "../render/support-preview.js";

export function createPreviewMcpResult(result:RenderPreviewResult):{
  content:Array<{type:"text";text:string}|{type:"image";data:string;mimeType:"image/png"}>;
  structuredContent:RenderPreviewResult["summary"];
}{
  const text=JSON.stringify(result.summary,null,2);
  return{content:[{type:"text",text},{type:"image",data:result.png.toString("base64"),mimeType:"image/png"}],structuredContent:result.summary};
}
