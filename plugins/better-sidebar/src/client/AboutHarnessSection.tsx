import { useEffect, useState } from 'react'
import { api } from './api.ts'
import { t } from './locales.ts'
import css from './AboutHarnessSection.module.css'

const APP_AUTHOR = 'zhee'
const APP_REPOSITORY_URL = 'https://github.com/snzhi000-sys/harness-macos-desktop-plugin-suite'

export function AboutHarnessSection() {
  const [info, setInfo] = useState<{ version: string; builtAt: string | null; channel: 'dev' | 'stable' | null } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void api.appReleaseInfo(controller.signal).then(setInfo).catch(() => { if (!controller.signal.aborted) setInfo({ version: 'v1.00.00', builtAt: null, channel: null }) })
    return () => controller.abort()
  }, [])
  const channel = info?.channel === 'dev' ? t('aboutTestBuild') : info?.channel === 'stable' ? t('aboutStableBuild') : t('aboutUnknownBuild')
  const time = info?.builtAt === null || info?.builtAt === undefined ? t('aboutUnknownTime') : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(info.builtAt))
  const channelClass = info?.channel === 'dev' ? css.test : info?.channel === 'stable' ? css.stable : undefined
  return <div className={css.section}><div className={css.title}>{t('aboutTitle')}</div><div className={css.row}><span>{t('aboutAuthor')}</span><strong>{APP_AUTHOR}</strong></div><div className={css.row}><span>{t('aboutRepository')}</span><a className={css.link} href={APP_REPOSITORY_URL} target="_blank" rel="noreferrer">{APP_REPOSITORY_URL}</a></div><div className={css.row}><span>{t('aboutVersion')}</span><strong>{info?.version ?? '…'}</strong></div><div className={css.row}><span>{t('aboutBuiltAt')}</span><strong>{time}</strong></div><div className={css.row}><span>{t('aboutChannel')}</span><strong className={channelClass}>{channel}</strong></div></div>
}
