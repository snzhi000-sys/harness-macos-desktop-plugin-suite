import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { installDragonBonesCompatibility } from '../src/dragonbones-compat.mjs'

test('the pinned real runtime blends equivalent rotations across the 180 degree boundary', () => {
  const context=vm.createContext({console,PIXI:{Sprite:class{},ExtensionType:{LoadParser:1}}})
  vm.runInContext(readFileSync(new URL('../assets/cores/dragonbones.js',import.meta.url),'utf8'),context)
  const db=context.dragonBones
  const constraint=()=>{
    const c=new db.TransformConstraint(),root={global:new db.Transform(),globalTransformMatrix:new db.Matrix()},target={globalTransformMatrix:new db.Matrix()}
    const source=new db.Transform();source.rotation=-Math.PI/2;source.toMatrix(root.globalTransformMatrix)
    source.rotation=Math.PI/2;source.toMatrix(target.globalTransformMatrix)
    c._root=root;c._bone=root;c._target=target;c._rotateWeight=.1;c._translateWeight=0;c._scaleWeight=0
    c._constraintData={local:false,offsetRotation:179.97*Math.PI/180,offsetX:0,offsetY:0,offsetScaleX:0,offsetScaleY:0}
    return c
  }
  const upstream=constraint();upstream._compute()
  assert.ok(Math.abs(upstream._root.global.rotation+Math.PI/2)>.5,'Reproduce the official full-turn blend defect')
  installDragonBonesCompatibility(db)
  const fixed=constraint(),offset=fixed._constraintData.offsetRotation;fixed._compute()
  assert.ok(Math.abs(fixed._root.global.rotation+Math.PI/2)<.001)
  assert.equal(fixed._constraintData.offsetRotation,offset,'Authored data remains unchanged')
  installDragonBonesCompatibility(db)
  const again=constraint();again._compute();assert.equal(again._root.global.rotation,fixed._root.global.rotation)
})
