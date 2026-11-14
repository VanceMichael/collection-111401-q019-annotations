import { ANNOTATION_PAGE } from './page.mjs';
export const initialState = { generation: 1, mode: 'normal', clock: 1000 };
export async function stop(state) {  }
export async function routes(context) {
 const { request, url, body, payload, state, json, text, binary } = context;

 const version='manual-'+state.generation;
 if(url.pathname==='/portal')return text(ANNOTATION_PAGE,200,{'content-type':'text/html; charset=utf-8'});
 if(url.pathname==='/document')return json({id:'device-manual',version,portal:'/portal',title:'样件说明'});
 if(url.pathname==='/version'&&request.method==='POST'){state.generation++;return json({version:'manual-'+state.generation});}
 if(url.pathname==='/segments'){
  const page=Number(url.searchParams.get('page')??0);const paragraphs=page===0?[
   {id:'toc',section:'contents',text:'目录中提到：设备功率为十瓦。'},
   {id:'main',section:'power',text:state.generation===1?'正式参数：设备功率为十瓦。适用标准工况。':'正式参数：设备功率为十二瓦。适用标准工况。'},
   ...(state.mode==='ambiguous'?[{id:'duplicate',section:'power',text:'另一个工况：设备功率为十瓦。'}]:[])
  ]:[{id:'later',section:'warranty',text:'保修范围以双方确认的清单为准。'}];return json({version,paragraphs,next:page===0?1:null});
 }
 if(url.pathname==='/threads'){
  const page=Number(url.searchParams.get('page')??0);return json({version,threads:page===0?[{id:'n-1',author:'资料审核员',comment:'请确认额定值',quote:'设备功率为十瓦',section:'power',status:'open'}]:[{id:'n-2',author:'复核员',comment:'范围已确认',quote:'保修范围',section:'warranty',status:state.generation===1?'resolved':'deleted'}],next:page===0?1:null});
 }

}
