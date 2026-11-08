const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, requireModule) {
 const module = { exports: {} };
 const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText;
 vm.runInNewContext(source, { module, exports: module.exports, require: requireModule, navigator: { userAgent: 'test' } });
 return module.exports;
}
const errors = load('src/utils/loginErrors.ts', () => {});
test('网络错误不误报密码错误，未知错误不泄露原始响应', () => {
 for (const error of [new Error('Failed to fetch'), {code:'NETWORK_ERROR'}, {message:'请求在15s内未完成，已中断'}, {error:'timeout'}]) {
  assert.match(errors.loginErrorMessage(error), /连接失败或请求超时/);
 }
 assert.match(errors.loginErrorMessage({code:'invalid_username_or_password'}), /用户名或密码错误/);
 assert.match(errors.loginErrorMessage({category:'INVALID_CREDENTIALS'}), /用户名或密码错误/);
 assert.match(errors.loginErrorMessage({code:'provider_not_enabled'}), /联系管理员/);
 assert.match(errors.loginErrorMessage({code:'too_many_requests'}), /频繁/);
 assert.equal(errors.loginErrorMessage({message:'private token value'}).includes('private'), false);
});
function page(signIn) {
 const slots = [], messages = [], navigations = [], requests = [];
 let cursor = 0, tree;
 const node = (type, props) => ({type,props});
 const { Login } = load('src/pages/Login.tsx', id => {
  if(id === 'react/jsx-runtime') return {jsx:node,jsxs:node};
  if(id === 'react') return {
   useState(initial) { const i=cursor++; if(!(i in slots)) slots[i]=initial; return [slots[i], value=>{slots[i]=value}]; },
   useRef(initial) { const i=cursor++; return slots[i] ||= {current:initial}; }
  };
  if(id === 'tdesign-react') return {Input:'input',Button:'button', MessagePlugin: Object.fromEntries(['warning','error','success'].map(key=>[key,message=>messages.push({key,message})]))};
  if(id === 'lucide-react') return {Package:'icon'};
  if(id === 'react-router-dom') return {useNavigate:()=> (...args)=>navigations.push(args),useLocation:()=>({})};
  if(id === '../contexts/PermissionContext') return {usePermission:()=>({refreshPermissions:async()=>{}})};
  if(id === '../utils/loginErrors') return errors;
  if(id === '../lib/cloudbase') return {signIn,callFunction:async(name,payload)=>{requests.push({name,payload})},getCurrentPermissionUserPayload:async()=>null};
  throw Error(id);
 });
 const render = () => {cursor=0;tree=Login();};
 const nodes = (type, root=tree) => {
  if(!root || typeof root!=='object') return [];
  if(Array.isArray(root)) return root.flatMap(item=>nodes(type,item));
  return [...(root.type===type?[root]:[]),...nodes(type,root.props?.children ?? null)];
 };
 render(); const inputs=nodes('input'); inputs[0].props.onChange('test'); inputs[1].props.onChange('test-only'); render();
 return {messages,navigations,requests,submit:()=>nodes('button')[0].props.onClick(), loading:()=>{render();return nodes('button')[0].props.loading}};
}
test('SDK 返回网络错误或抛出异常后都恢复登录按钮，允许重试', async()=>{
 for(const rejected of [false,true]) {
  let calls=0;
  const ui=page(async()=>{calls++; if(rejected) throw Error('network error'); return {error:{code:'NETWORK_ERROR'}};});
  await ui.submit(); assert.equal(ui.loading(),false); assert.equal(ui.navigations.length,0);
  assert.match(ui.messages[0].message,/连接失败/);
  assert.match(ui.requests[0].payload.data.failReason,/连接失败/);
  await ui.submit(); assert.equal(calls,2);
 }
});
test('登录期间重复提交只发一次请求，成功后才跳转', async()=>{
 let resolve, calls=0;
 const pending=new Promise(yes=>{resolve=yes});
 const ui=page(()=>{calls++; return pending});
 const first=ui.submit(); assert.equal(ui.loading(),true);
 await ui.submit(); assert.equal(calls,1);
 resolve({error:null}); await first;
 assert.equal(ui.loading(),false); assert.equal(ui.navigations.length,1);
 assert.equal(ui.messages[0].key,'success');
});
