// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { bindFormState } from './form-state'

afterEach(() => { document.body.replaceChildren() })

function setup() {
  document.body.innerHTML = `<dialog open><form id="profile"><input id="name" value="Original"><input id="weight" type="number" value="60"><input id="enabled" type="checkbox" checked><select id="driver"><option value="one">One</option><option value="two">Two</option></select></form><button form="profile" type="submit">Save</button><button data-dialog-close>Cancel</button></dialog>`
  const form = document.querySelector('form')!
  const button = document.querySelector('button')!
  const name = document.querySelector<HTMLInputElement>('#name')!
  return { form, button, name, state: bindFormState(form, button) }
}

it('does not enable Save until loaded, and clears dirty state when reverted', () => {
  const { form, button, name, state } = setup()
  expect(button.disabled).toBe(true)
  state.reset()
  expect(button.disabled).toBe(true)
  name.value = 'Changed'
  form.dispatchEvent(new Event('input'))
  expect(button.disabled).toBe(false)
  name.value = 'Original'
  form.dispatchEvent(new Event('input'))
  expect(button.disabled).toBe(true)
})

it('tracks checkboxes and dynamic driver controls, normalizing numeric formatting', () => {
  const { form, button, state } = setup()
  form.insertAdjacentHTML('beforeend', '<input id="config-url" value="printer.local">')
  state.reset()
  document.querySelector<HTMLInputElement>('#weight')!.value = '60.0'
  state.update()
  expect(button.disabled).toBe(true)
  document.querySelector<HTMLInputElement>('#weight')!.value = '60.1'
  state.update()
  expect(button.disabled).toBe(false)
  state.reset()
  document.querySelector<HTMLInputElement>('#enabled')!.checked = false
  form.dispatchEvent(new Event('change'))
  expect(button.disabled).toBe(false)
})

it('keeps the failed draft dirty and freezes fields during a pending save', () => {
  const { form, button, name, state } = setup()
  state.reset()
  name.value = 'Retry me'
  state.setBusy(true)
  expect(button.disabled).toBe(true)
  expect(form.inert).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('[data-dialog-close]')!.disabled).toBe(true)
  state.setBusy(false)
  expect(name.value).toBe('Retry me')
  expect(button.disabled).toBe(false)
  state.reset()
  expect(button.disabled).toBe(true)
})

it('keeps independent profile and password save states separate', () => {
  const { button, state } = setup()
  state.reset()
  const password = document.createElement('form')
  password.innerHTML = '<input type="password"><button>Change password</button>'
  document.body.append(password)
  const passwordButton = password.querySelector('button')!
  const passwordState = bindFormState(password, passwordButton)
  passwordState.reset()
  password.querySelector('input')!.value = 'temporary draft'
  password.dispatchEvent(new Event('input'))
  expect(passwordButton.disabled).toBe(false)
  expect(button.disabled).toBe(true)
})
