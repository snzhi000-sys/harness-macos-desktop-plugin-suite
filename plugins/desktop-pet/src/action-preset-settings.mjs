/** Saved action variants and phoneme recipes share a leased live preview. */
import { mouthPhonemes } from './action-presets.mjs'
export function mountActionPresetSettings(root, status) {
  root.innerHTML='<style>.pet-actions{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px}.pet-actions-help{margin:0;color:#6f7888;font-size:12px;line-height:1.55}.pet-actions-toolbar{display:flex;align-items:center;gap:10px;flex:none}.pet-actions-toolbar label{display:flex;align-items:center;gap:8px;margin:0;flex:1}.pet-actions-toolbar select{min-width:220px}.pet-actions-list{min-height:0;overflow:auto;padding-right:8px;scrollbar-gutter:stable}.pet-actions-list fieldset{background:#fbfcfe;box-shadow:0 1px 3px #1720330d}.pet-actions-list fieldset:hover{border-color:#b9c8e5!important}.pet-actions-list textarea{width:100%;resize:vertical}.pet-actions-list h3{position:sticky;top:0;background:#fff;z-index:1;padding:8px 0;margin:16px 0 4px;border-bottom:1px solid #edf0f4}</style><div class="pet-actions"><p class="pet-actions-help">同一动作可保存多个权重预设。关键词只匹配括号内文字，最长优先，等长按列表顺序。拖动滑块实时预览，松开恢复；修改会保留到设置页底部保存。</p><div class="pet-actions-toolbar"><label>角色与服装<select data-action-character></select></label></div><div class="pet-actions-list" data-action-keywords></div></div>'
  const select=root.querySelector('select'), list=root.querySelector('[data-action-keywords]'), channel=new BroadcastChannel('dsh-pet-action-debug')
  const layout=document.createElement('div');layout.style.cssText='display:grid;grid-template-columns:230px minmax(0,1fr);gap:20px;align-items:stretch;min-height:0;flex:1'
  const portrait=document.createElement('iframe');portrait.title='动作立绘预览';portrait.src='about:blank';portrait.style.cssText='width:230px;height:390px;border:0;position:sticky;top:0;background:#faf8f3;border-radius:12px;box-shadow:0 2px 10px #17203312'
  list.before(layout);layout.append(portrait,list)
  let draft={}, recipes={}, revision=0, disposed=false, held, timer, animated=false, visible=false
  const json=async path=>{const r=await fetch('/desktop-pet/api/'+path),value=await r.json();if(!r.ok)throw Error(value.error);return value}
  const stop=()=>{clearInterval(timer);if(held)channel.postMessage({...held,kind:'release'});held=null}
  const send=()=>{if(held)channel.postMessage({...held,kind:'hold'})}
  const begin=selection=>{stop();if(!animated){status('请先开启并保存动画设置，再预览。');return}held={modelId:select.value,token:crypto.randomUUID(),selection};send();timer=setInterval(send,250)}
  const visibility=()=>{if(document.hidden)stop()};window.addEventListener('blur',stop);document.addEventListener('visibilitychange',visibility)
  const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;return b}
  const label=(text,input)=>{const el=document.createElement('label');el.append(document.createTextNode(text),input);return el}
  const fieldset=()=>{const row=document.createElement('fieldset');row.style.cssText='margin:12px 0;padding:14px;border:1px solid #dfe3ea;border-radius:10px';return row}
  const input=(value,change)=>{const el=document.createElement('input');el.value=value;el.oninput=()=>change(el.value);return el}
  const options=(items,value,change)=>{const el=document.createElement('select');for(const [id,text] of items){const o=document.createElement('option');o.value=id;o.textContent=text;el.append(o)}el.value=value;el.onchange=()=>{stop();change(el.value)};return el}
  const previewControls=(row,model,selection,weight,update)=>{
    const slider=document.createElement('input'),number=document.createElement('input');slider.type='range';number.type='number'
    for(const el of [slider,number]){el.min='0';el.max='100';el.step='1';el.value=String(Math.round(weight*100));el.disabled=model.kind!=='dragonbones';el.onblur=stop}
    slider.dataset.weight='';number.dataset.weightNumber='';slider.setAttribute('aria-label','动作权重');number.setAttribute('aria-label','权重百分比')
    const value=()=>Number(slider.value)/100
    const change=(source,target)=>{const n=Number(source.value);if(!Number.isFinite(n)||n<0||n>100){status('权重须为 0–100%。');return}target.value=source.value;update(n/100);if(!held)begin({...selection(),weight:n/100});else{held.selection.weight=n/100;send()}}
    slider.oninput=()=>change(slider,number);number.oninput=()=>change(number,slider)
    slider.onpointerdown=e=>{if(e.button===0){slider.setPointerCapture(e.pointerId);begin({...selection(),weight:value()})}}
    slider.onpointerup=slider.onpointercancel=slider.onlostpointercapture=slider.onkeyup=stop
    const preview=button('按住预览',null)
    preview.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();preview.setPointerCapture(e.pointerId);begin({...selection(),weight:value()})}
    preview.onpointerup=preview.onpointercancel=preview.onlostpointercapture=preview.onblur=preview.onkeyup=stop
    preview.onkeydown=e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();if(!e.repeat)begin({...selection(),weight:value()})}}
    row.append(label(model.kind==='dragonbones'?'动作权重 %':'当前引擎保留完整动作（100%）',slider),number,preview)
  }
  const render=async()=>{
    stop();const token=++revision,id=select.value;list.replaceChildren()
    try{
      const model=await json('model?id='+encodeURIComponent(id));if(disposed||token!==revision)return
      const src='/desktop-pet/view?preview=1&model='+encodeURIComponent(id)
      if(visible&&portrait.getAttribute('src')!==src)portrait.src=src
      const modules=model.actionModules.filter(a=>a.category==='body'&&a.automaticEligible)
      draft[id]??=modules.map(a=>({id:'default:'+a.id,actionId:a.id,name:a.label,weight:1,enabled:true,keywords:[]}))
      const entries=draft[id],conflict=document.createElement('p');conflict.dataset.keywordConflict='';list.append(conflict)
      const check=()=>{const seen=new Set(),duplicates=new Set();for(const p of entries.filter(p=>p.enabled))for(const tag of p.keywords){const key=tag.toLocaleLowerCase();if(seen.has(key))duplicates.add(tag);seen.add(key)}conflict.textContent=duplicates.size?'重复关键词按列表顺序匹配：'+[...duplicates].join('、'):''}
      list.append(button('新建动作预设',()=>{if(modules.length){entries.push({id:crypto.randomUUID(),name:'新动作预设',actionId:modules[0].id,weight:1,enabled:true,keywords:[]});void render()}}))
      for(const [index,p] of entries.entries()){
        const row=fieldset();row.dataset.presetId=p.id
        const fold=button('收起设置',()=>{const collapsed=fold.dataset.collapsed==='1';for(const child of [...row.children].slice(1))child.hidden=!collapsed;fold.dataset.collapsed=collapsed?'0':'1';fold.textContent=collapsed?'收起设置':'展开设置'});fold.style.cssText='float:right;margin:-4px 0 6px 8px;padding:4px 8px;font-size:11px';row.append(fold)
        const name=input(p.name,v=>{p.name=v});name.dataset.presetName=''
        const choices=modules.map(a=>[a.id,a.label]);if(!modules.some(a=>a.id===p.actionId))choices.push([p.actionId,'动作已不可用：'+p.actionId])
        const source=options(choices,p.actionId,v=>{p.actionId=v;void render()});source.dataset.presetSource=''
        const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=p.enabled;enabled.onchange=()=>{p.enabled=enabled.checked;check()}
        row.append(label('预设名称',name),label('原始动作',source),label('启用关键词触发',enabled))
        previewControls(row,model,()=>modules.find(a=>a.id===p.actionId)??{},p.weight,v=>{p.weight=v})
        const tags=document.createElement('textarea');tags.dataset.actionId=p.actionId;tags.value=p.keywords.join('\n');tags.placeholder='每行一个关键词';tags.style.minHeight='75px';tags.oninput=()=>{p.keywords=[...new Set(tags.value.split('\n').map(t=>t.trim()).filter(Boolean))];check()}
        row.append(label('关键词',tags),button('复制预设',()=>{entries.splice(index+1,0,{...structuredClone(p),id:crypto.randomUUID(),name:p.name+' 副本'});void render()}),button('上移',()=>{if(index){[entries[index-1],entries[index]]=[entries[index],entries[index-1]];void render()}}),button('删除预设',()=>{entries.splice(index,1);void render()}));list.append(row)
      }
      check()
      if(model.kind==='dragonbones'&&recipes[id]){
        const title=document.createElement('h3');title.textContent='发音嘴型配方';list.append(title)
        const help=document.createElement('p');help.textContent='e/w/y 等发音标签可复用 a/o/i/m 的不同权重，自动说话按拼音字符匹配。未配置字符沿用基础嘴型。扩展默认值是可调整的近似效果，不是新制作的素材。';list.append(help)
        list.append(button('新增发音配方',()=>{const unused=mouthPhonemes.find(c=>!recipes[id].some(r=>r.phoneme===c));if(unused){recipes[id].push({phoneme:unused,base:'i',weight:.5});void render()}else status('当前支持的发音匹配项均已配置。')}))
        for(const [i,r] of recipes[id].entries()){
          const row=fieldset();row.dataset.phoneme=r.phoneme
          const phoneme=options(mouthPhonemes.filter(p=>p===r.phoneme||!recipes[id].some(r=>r.phoneme===p)).map(p=>[p,p]),r.phoneme,v=>{r.phoneme=v;void render()});phoneme.disabled=['a','o','i','m'].includes(r.phoneme)
          const base=options(['a','o','i','m'].map(s=>[s,s]),r.base,v=>{r.base=v})
          row.append(label('发音匹配符号',phoneme),label('基础嘴型',base));previewControls(row,model,()=>({animation:'__speech_'+r.base}),r.weight,v=>{r.weight=v})
          if(!['a','o','i','m'].includes(r.phoneme))row.append(button('删除配方',()=>{recipes[id].splice(i,1);void render()}));list.append(row)
        }
      }
    }catch(error){if(!disposed&&token===revision)status(error.message)}
  }
  select.onchange=render
  return{
    async load(config){
      stop();draft=structuredClone(config.actionPresets);recipes=structuredClone(config.mouthRecipes);const token=++revision
      const [models,settings]=await Promise.all([json('models'),json('settings')]);if(disposed||token!==revision)return;animated=settings.animated
      const previous=select.value;select.replaceChildren();for(const model of models){const option=document.createElement('option');option.value=model.id;option.textContent=model.name+(model.outfitName?' · '+model.outfitName:'');select.append(option)}select.value=models.some(m=>m.id===previous)?previous:settings.modelId;await render();select.disabled=false
    },
    value(){return{actionPresets:draft,mouthRecipes:recipes}},stop,
    show(value){visible=value;stop();portrait.src=value&&select.value?'/desktop-pet/view?preview=1&model='+encodeURIComponent(select.value):'about:blank'},
    suspend(){++revision;stop();portrait.src='about:blank'},
    dispose(){disposed=true;++revision;stop();channel.close();window.removeEventListener('blur',stop);document.removeEventListener('visibilitychange',visibility);root.replaceChildren()},
  }
}
