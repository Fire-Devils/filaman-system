/** Compare rendered controls: API defaults and numeric formatting may differ. */
export function bindFormState(form: HTMLFormElement, submit: HTMLButtonElement) {
  let baseline: string | null = null
  let busy = false
  const signature = () => JSON.stringify([...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')].map(field => [
    field.id || field.name,
    field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type) ? field.checked
      : field instanceof HTMLInputElement && field.type === 'number' && field.value !== '' ? field.valueAsNumber
        : field instanceof HTMLSelectElement && field.multiple ? [...field.selectedOptions].map(option => option.value) : field.value,
  ]))
  function update() {
    const dirty = baseline !== null && signature() !== baseline
    submit.disabled = busy || !dirty
    form.dataset.dirty = String(dirty)
  }
  form.addEventListener('input', update)
  form.addEventListener('change', update)
  update()
  return {
    get busy() { return busy },
    update,
    reset() { baseline = signature(); update() },
    setBusy(value: boolean) {
      busy = value
      form.inert = value
      const cancel = form.closest('dialog')?.querySelector<HTMLButtonElement>('[data-dialog-close]')
      if (cancel) cancel.disabled = value
      form.setAttribute('aria-busy', String(value))
      update()
    },
  }
}
