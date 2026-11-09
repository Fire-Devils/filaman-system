// @vitest-environment happy-dom
import {describe,it,expect} from 'vitest'
import {mountIntegrationPlugin} from './plugin-integration-shell'
describe('integration plugin shell',()=>{
 it('mounts once so host presentation changes preserve child discovery state',async()=>{
  const frame=document.createElement('iframe');document.body.append(frame)
  mountIntegrationPlugin(frame,'example-plugin')
  const src=frame.src
  document.documentElement.dataset.theme='light';document.documentElement.lang='fr'
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(frame.src).toBe(src)
  expect(new URL(src).pathname).toBe('/plugins/example-plugin/')
  expect(()=>mountIntegrationPlugin(frame,'../../admin')).toThrow()
 })
})
