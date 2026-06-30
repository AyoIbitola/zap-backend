import type { LightningProvider } from './provider.interface.js'
import { LNbitsProvider } from './lnbits.provider.js'
import { LNDProvider } from './lnd.provider.js'

let _provider: LightningProvider | null = null

export function createLightningProvider(): LightningProvider {
  const provider = process.env.LIGHTNING_PROVIDER
  if (provider === 'LNBITS') return new LNbitsProvider()
  if (provider === 'LND') return new LNDProvider()
  throw new Error(`Unknown or missing LIGHTNING_PROVIDER: "${provider}". Must be LNBITS or LND.`)
}

export function getLightningProvider(): LightningProvider {
  if (!_provider) _provider = createLightningProvider()
  return _provider
}
