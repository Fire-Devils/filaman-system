import { request } from '../api'
import type { LabelAssetClient, LabelAssetMetadata } from './editor-controller'

const ASSET_PATH = '/me/label-assets'

type AssetResponse = Omit<LabelAssetMetadata, 'content_url'>

function withContentUrl(asset: AssetResponse): LabelAssetMetadata {
  return {
    ...asset,
    content_url: labelAssetContentUrl(asset.id),
  }
}

export function createLabelAssetClient(): LabelAssetClient {
  return {
    async list() {
      return (await request<AssetResponse[]>(ASSET_PATH)).map(withContentUrl)
    },
    async upload(file) {
      const body = new FormData()
      body.append('file', file)
      return withContentUrl(await request<AssetResponse>(ASSET_PATH, {
        method: 'POST',
        body,
      }))
    },
    async delete(assetId) {
      await request(`${ASSET_PATH}/${encodeURIComponent(assetId)}`, {
        method: 'DELETE',
      })
    },
  }
}

export function labelAssetContentUrl(assetId: string) {
  return `/api/v1${ASSET_PATH}/${encodeURIComponent(assetId)}/content`
}
