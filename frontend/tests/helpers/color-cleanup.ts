import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import ColorEditorFields from '../../src/components/ColorEditorFields.astro'

export async function colorCleanupFixture() {
  const container = await AstroContainer.create()
  const editor = await container.renderToString(ColorEditorFields, { props: { idPrefix: 'cleanup', wheel: true } })
  return `<button id="btn-review-colors"></button><button id="color-select-matching"></button>
    <button id="color-merge-selected"></button><button id="color-clear-selection"></button><button id="color-delete-selected"></button>
    <span id="color-selection-count"></span><input id="color-select-loaded" type="checkbox">
    <table id="colors-list-table"><tbody><tr><td><input data-color-select="1"></td></tr></tbody></table>
    <dialog id="color-cleanup-dialog"><h2 id="color-cleanup-title"></h2><button data-dialog-close>Close</button>
      <div id="color-cleanup-content"></div>
      <form data-cleanup-merge-form hidden><label for="cleanup-survivor">Keep this color</label><select id="cleanup-survivor"></select>
        ${editor}<p data-cleanup-warning role="note"></p><button type="submit" data-cleanup-merge>Merge selected colors</button>
      </form>
    </dialog>`
}
