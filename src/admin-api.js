/*
 * Separate MediaGrab admin API Worker.
 * Do NOT replace the existing Telegram bot worker with this file.
 */
const enc = new TextEncoder();
const cors = (request, env) => {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": origin === (env.PANEL_ORIGIN || "") ? origin : "null",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
};
const json = (data, status=200, headers={}) => new Response(JSON.stringify(data), {status,headers});
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
async function sign(secret, value) {
  const key = await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return b64(await crypto.subtle.sign("HMAC",key,enc.encode(value)));
}
async function session(username, env) {
  const payload=b64(enc.encode(JSON.stringify({u:username,e:Date.now()+8*60*60*1000})));
  return payload+"."+await sign(env.SESSION_SECRET,payload);
}
async function authenticated(request,env) {
  const m=(request.headers.get("Cookie")||"").match(/(?:^|;\s*)mg_session=([^;]+)/);
  if(!m)return false;const p=m[1].split(".");if(p.length!==2)return false;
  if(await sign(env.SESSION_SECRET,p[0])!==p[1])return false;
  try{const x=JSON.parse(atob(p[0].replace(/-/g,"+").replace(/_/g,"/")));return x.u===env.ADMIN_USERNAME&&x.e>Date.now()}catch{return false}
}
const cookie=(value,age)=>`mg_session=${value}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${age}`;
export default { async fetch(request,env) {
  const h=cors(request,env), url=new URL(request.url);
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers:h});
  if(url.pathname==="/health")return json({ok:true,service:"mediagrab-admin-api"},200,h);
  if(url.pathname==="/admin-api/login"&&request.method==="POST"){
    let body;try{body=await request.json()}catch{return json({error:"Invalid JSON"},400,h)}
    if(!env.ADMIN_USERNAME||!env.ADMIN_PASSWORD||!env.SESSION_SECRET)return json({error:"Admin secrets are not configured"},500,h);
    if(body.username!==env.ADMIN_USERNAME||body.password!==env.ADMIN_PASSWORD)return json({error:"Invalid username or password"},401,h);
    const token=await session(body.username,env);return json({ok:true},200,{...h,"Set-Cookie":cookie(token,28800)});
  }
  if(url.pathname==="/admin-api/logout"&&request.method==="POST")return json({ok:true},200,{...h,"Set-Cookie":cookie("",0)});
  if(!await authenticated(request,env))return json({error:"Unauthorized"},401,h);
  if(url.pathname==="/admin-api/overview"&&request.method==="GET"){
    try{
      const stats=await env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success,SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) failed,COUNT(DISTINCT telegram_user_id) unique_users FROM download_events`).first();
      const daily=await env.DB.prepare(`SELECT strftime('%Y-%m-%d',created_at) day,COUNT(*) total FROM download_events WHERE created_at>=datetime('now','-6 days') GROUP BY strftime('%Y-%m-%d',created_at) ORDER BY day`).all();
      const recent=await env.DB.prepare(`SELECT created_at,telegram_user_id,source_host,media_type,status,details FROM download_events ORDER BY id DESC LIMIT 20`).all();
      return json({stats:stats||{},daily:daily.results||[],recent:recent.results||[],health:{database:true,webhook:"Not checked"}},200,h);
    }catch{return json({error:"Database query failed. Apply schema.sql first."},500,h)}
  }
  return json({error:"Not found"},404,h);
}};
