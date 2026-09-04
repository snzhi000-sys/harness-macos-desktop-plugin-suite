/** Models-page extension slots owned by provider companion plugins. */

import type { ConfigurableProviderView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Provider-specific controls keyed by the owning settings namespace. */
    'settings.models.provider-card': { kind: 'keyed'; scope: 'root'; owner: ProviderCardExtrasOwnerProps }
    /** Ordered extension area after all provider rows. */
    'settings.models.footer': { kind: 'list'; scope: 'root'; owner: ModelsFooterOwnerProps }
  }
}

/** Provider facts exposed to one provider-card extension. */
export interface ProviderCardExtrasOwnerProps {
  /** Directory row whose card is being rendered. */
  provider: ConfigurableProviderView
  /** Whether any settings layer configures this route. */
  configured: boolean
  /** Whether the referenced API-key credential is confirmed configured. */
  keyConfigured: boolean
}

/** Owner share of the Models footer extension area. */
export interface ModelsFooterOwnerProps {
  /** Marker field: the footer owner supplies no values. */
  children?: never
}
