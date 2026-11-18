import { OPENAPI_PATH } from "./openapi-path";

/**
 * Dependency-free viewer for the OpenAPI document: no Scalar or Swagger UI package is installed and the
 * server must not fetch from the internet, so this page renders the spec itself with a few lines of
 * vanilla JS (tags, operations, parameters, bodies, responses, schemas with $refs expanded one level).
 * Everything user-visible is set with textContent, never innerHTML.
 */
export const DOCS_HTML: string = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>orch API docs</title>
<style>
:root{color-scheme:light dark;font:14px/1.45 system-ui,sans-serif}
body{margin:0 auto;max-width:980px;padding:16px}
h1{font-size:20px} h2{font-size:16px;margin:24px 0 4px;text-transform:capitalize}
details{border:1px solid #8884;border-radius:6px;margin:4px 0;padding:4px 8px}
summary{cursor:pointer;font-family:ui-monospace,monospace}
.m{display:inline-block;min-width:54px;font-weight:700}
pre{background:#8881;padding:8px;border-radius:4px;overflow:auto;font-size:12px}
.d{opacity:.75} input{width:100%;padding:6px;margin:8px 0;box-sizing:border-box}
</style></head><body>
<h1 id="t">orch API docs</h1><p class="d" id="s"></p>
<input id="q" placeholder="Filter by path, summary or tag" aria-label="Filter">
<div id="o">Loading…</div>
<script>
(function(){
var el=function(tag,text,cls){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};
var token=null;try{token=sessionStorage.getItem(${JSON.stringify("orch-token")})}catch(e){}
var headers=token?{Authorization:"Bearer "+token}:{};
fetch(${JSON.stringify(OPENAPI_PATH)},{headers:headers}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(render).catch(function(e){document.getElementById("o").textContent="Could not load the spec: "+e.message});
function deref(spec,s){if(s&&s.$ref){var n=s.$ref.split("/").pop();return spec.components.schemas[n]||s}return s}
function show(spec,s,depth){
  if(!s)return"";var ref=s.$ref?s.$ref.split("/").pop():null;var r=deref(spec,s);
  if(depth>2||!r.properties&&!r.items)return ref||JSON.stringify(r);
  var out={};if(r.items)return"["+show(spec,r.items,depth+1)+"]";
  Object.keys(r.properties).forEach(function(k){out[k]=show(spec,r.properties[k],depth+1)});
  return(ref?ref+" ":"")+JSON.stringify(out,null,2);
}
function render(spec){
  document.getElementById("t").textContent=spec.info.title+" "+spec.info.version;
  var sec=spec.components&&spec.components.securitySchemes||{};
  document.getElementById("s").textContent=spec.info.description+" Auth: "+Object.keys(sec).map(function(k){return sec[k].description}).join(" ");
  var groups={};
  Object.keys(spec.paths).forEach(function(p){Object.keys(spec.paths[p]).forEach(function(m){
    var op=spec.paths[p][m];var tag=(op.tags||["other"])[0];(groups[tag]=groups[tag]||[]).push({p:p,m:m,op:op})})});
  var root=document.getElementById("o");root.textContent="";var rows=[];
  Object.keys(groups).sort().forEach(function(tag){
    root.appendChild(el("h2",tag));
    groups[tag].forEach(function(g){
      var d=document.createElement("details");var sm=document.createElement("summary");
      sm.appendChild(el("span",g.m.toUpperCase(),"m"));sm.appendChild(el("span",g.p+"  "));sm.appendChild(el("span",g.op.summary||"","d"));d.appendChild(sm);
      d.appendChild(el("p",g.op.description||""));
      (g.op.parameters||[]).forEach(function(q){d.appendChild(el("div",q.in+" "+q.name+(q.required?" (required)":"")+": "+(q.schema&&q.schema.type||"")+" "+(q.description||"")))});
      var b=g.op.requestBody&&g.op.requestBody.content&&g.op.requestBody.content["application/json"];
      if(b){d.appendChild(el("strong","Request body"));d.appendChild(el("pre",show(spec,b.schema,0)))}
      Object.keys(g.op.responses||{}).forEach(function(c){
        var r=g.op.responses[c];var j=r.content&&r.content["application/json"];
        d.appendChild(el("strong",c+" "+(r.description||"")));if(j)d.appendChild(el("pre",show(spec,j.schema,0)))});
      d.dataset.k=(g.m+" "+g.p+" "+(g.op.summary||"")+" "+tag).toLowerCase();root.appendChild(d);rows.push(d)});
  });
  document.getElementById("q").addEventListener("input",function(e){var v=e.target.value.toLowerCase();rows.forEach(function(d){d.hidden=v!==""&&d.dataset.k.indexOf(v)<0})});
}
})();
</script></body></html>
`;
