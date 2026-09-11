/** `settings.permission` namespace dictionaries (the Permission row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '权限',
  'description': '设置新会话的执行权限；文件修改审核始终保持开启',
  'loading': '加载中',
  'unavailable': '不可用',
  'confirm.title': '确认启用 Full access？',
  'confirm.description': 'Full access 允许 AI 在系统权限范围内读取和修改任意路径，并关闭权限审批提示；Shell 审核可能不完整，未记录的修改可能无法恢复。仅建议在你信任后续任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '启用 Full access',
} satisfies Record<string, string>

/** The settings.permission namespace key union. */
export type PermissionSettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Permission',
  'description': 'Set execution permission for new sessions; file-change review always remains enabled',
  'loading': 'Loading',
  'unavailable': 'Unavailable',
  'confirm.title': 'Enable Full access?',
  'confirm.description': 'Full access lets the AI read and modify any path allowed by the OS without permission prompts; Shell review may be incomplete and unrecorded changes may be unrecoverable. Use it only when you trust subsequent tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Full access',
} satisfies Record<PermissionSettingsKey, string>

/** Simplified Chinese dictionary for the current-session popup gate. */
export const accessZh = {
  'confirm.title': '确认启用 Full access？',
  'confirm.description': 'Full access 允许 AI 在系统权限范围内读取和修改任意路径，并关闭权限审批提示；Shell 审核可能不完整，未记录的修改可能无法恢复。仅建议在你信任当前任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '启用 Full access',
} satisfies Record<string, string>

/** Current-session popup-gate key union. */
export type PermissionAccessKey = keyof typeof accessZh

/** English dictionary for the current-session popup gate. */
export const accessEn = {
  'confirm.title': 'Enable Full access?',
  'confirm.description': 'Full access lets the AI read and modify any path allowed by the OS without permission prompts; Shell review may be incomplete and unrecorded changes may be unrecoverable. Use it only when you trust the current task.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Full access',
} satisfies Record<PermissionAccessKey, string>
