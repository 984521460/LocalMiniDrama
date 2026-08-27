import {
  createAssetLocator,
  type AssetLocator,
  type StorageProvider,
} from '../src/index.js'

const locator: AssetLocator = createAssetLocator({
  logicalSegments: ['dramas', 'demo', 'poster', 'v1'],
  relativeSegments: ['projects', 'demo', 'assets', 'poster', 'v1.png'],
})

declare const provider: StorageProvider<Uint8Array>
provider.read(locator).then((content) => content.byteLength)

// @ts-expect-error Absolute roots are not part of the public locator contract.
locator.absolutePath

// @ts-expect-error StorageProvider implementations must not accept plain absolute paths.
provider.read('C:\\private\\asset.png')
