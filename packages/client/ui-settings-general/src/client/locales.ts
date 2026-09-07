/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'connection.connecting': '正在连接',
  'connection.stalled': '连接响应较慢',
  'connection.reconnecting': '正在重连…',
  'connection.reconnect': '立即重连',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'connection.connecting': 'Connecting',
  'connection.stalled': 'Connection is slow',
  'connection.reconnecting': 'Reconnecting…',
  'connection.reconnect': 'Reconnect now',
} satisfies Record<SettingsKey, string>
