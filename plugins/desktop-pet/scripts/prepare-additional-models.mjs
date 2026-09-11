/** Download only declared model data from pinned Git trees; browser acceptance is separate. */
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {dirname,join,resolve,posix} from 'node:path'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import JSON5 from 'json5'
import {inspectModel} from '../src/model-library.mjs'
import {suggestedProfile,validateProfile} from '../src/character-profile.mjs'
const output=resolve('../../desktop/.artifacts/pet-expansion-2026-09-09'),execute=promisify(execFile),commit='94ae3e5628226726af96c6b4bf0e1ce5c728e28e'
const groups=JSON.parse(await readFile(join(output,'groups.json'))),choices=JSON.parse(await readFile(new URL('additional-models.json',import.meta.url)))
const trees=new Map(await Promise.all(groups.map(async g=>[g.path,new Map(JSON.parse(await readFile(join(output,g.file))).tree.map(x=>[x.path,x]))])))
const blob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const results=[]
for(const choice of choices){
 try{
  const tree=trees.get(choice.group),folder=resolve('assets/models',choice.id);await mkdir(folder,{recursive:true})
  const obtain=async path=>{
   const item=tree.get(path);if(!item||item.type!=='blob'||item.mode!=='100644')throw Error(`Missing data file: ${path}`)
   const relative=posix.relative(posix.dirname(choice.entry),path);if(relative.startsWith('../'))throw Error('Escaping model directory')
   const target=join(folder,relative);try{const b=await readFile(target);if(blob(b)===item.sha)return b}catch(e){if(e.code!=='ENOENT')throw e}
   let error;for(let i=0;i<3;i++){try{const url=(i===0?`https://cdn.jsdelivr.net/gh/Eikanya/Live2d-model@${commit}/`:`https://raw.githubusercontent.com/Eikanya/Live2d-model/${commit}/`)+[choice.group,path].join('/').split('/').map(encodeURIComponent).join('/');const {stdout}=await execute('/usr/bin/curl',['-fLsS','--max-time','30',url],{encoding:'buffer',maxBuffer:64*1024*1024});if(blob(stdout)!==item.sha)throw Error('Git blob mismatch');await mkdir(dirname(target),{recursive:true});await writeFile(target,stdout);return stdout}catch(e){error=e}}throw error
  }
  const data=JSON5.parse((await obtain(choice.entry)).toString('utf8')),v4=Boolean(data.FileReferences),refs=data.FileReferences??data
  const motionFiles=[...new Set(Object.values(v4?refs.Motions??{}:refs.motions??{}).flat().map(m=>v4?m.File:m.file))]
  if(motionFiles.length<6)throw Error(`Only ${motionFiles.length} unique motions; not selected for the rich-action collection`)
  const files=[v4?refs.Moc:refs.model,...(v4?refs.Textures:refs.textures)]
  for(const key of v4?['Physics','Pose','DisplayInfo','UserData']:['physics','pose'])if(refs[key])files.push(refs[key])
  for(const group of Object.values(v4?refs.Motions??{}:refs.motions??{}))for(const motion of group)files.push(v4?motion.File:motion.file)
  for(const expression of v4?refs.Expressions??[]:refs.expressions??[])files.push(v4?expression.File:expression.file)
  const deps=[...new Set(files)];for(let i=0;i<deps.length;i+=4)await Promise.all(deps.slice(i,i+4).map(file=>{if(typeof file!=='string'||! /\.(moc3?|png|jpe?g|webp|json|mtn)$/i.test(file)||posix.isAbsolute(file))throw Error('Unsupported dependency');return obtain(posix.normalize(posix.join(posix.dirname(choice.entry),file)))}))
  for(const file of deps.filter(f=>f.endsWith('.json'))){const path=join(folder,file),bytes=await readFile(path,'utf8');try{JSON.parse(bytes)}catch{await writeFile(path,JSON.stringify(JSON5.parse(bytes)))}}
  if(v4)data.Groups=(data.Groups??[]).filter(g=>Array.isArray(g.Ids))
  const entry=join(folder,v4?'entry.model3.json':'entry.model.json');await writeFile(entry,JSON.stringify(data,null,2))
  const info=await inspectModel(entry),profile=validateProfile(suggestedProfile(info),info)
  const model={id:choice.id,name:choice.name,subtitle:choice.group.startsWith('碧蓝')?'碧蓝航线 · JP':choice.group,kind:info.kind,entry:`models/${choice.id}/${posix.basename(entry)}`,profile,source:`https://github.com/Eikanya/Live2d-model/tree/${commit}/${[choice.group,posix.dirname(choice.entry)].join('/').split('/').map(encodeURIComponent).join('/')}`,sourcePack:'2026-09-09'}
  await writeFile(join(folder,'SOURCE.json'),JSON.stringify({commit,entry:[choice.group,choice.entry].join('/'),blobs:[choice.entry,...deps.map(f=>posix.normalize(posix.join(posix.dirname(choice.entry),f)))].map(path=>({path,sha:tree.get(path).sha}))},null,2))
  results.push({status:'downloaded',model});console.log(`Downloaded ${choice.group} / ${choice.name}`)
 }catch(e){results.push({status:'failed',id:choice.id,error:e.message});console.error(choice.id,e.message)}
 await writeFile(join(output,'download-result.json'),JSON.stringify(results,null,2))
}
