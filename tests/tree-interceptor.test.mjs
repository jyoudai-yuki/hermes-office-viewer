/**
 * fork 补丁闸门 · 双击接管工作台文件树（dblclick-interceptor-v1）
 *
 *   node tests/tree-interceptor.test.mjs
 *
 * 在 Node 里用桩件加载**真实的** desktop/plugin.js，断言三件事：
 *   1. 补丁把两个 capture 监听挂到了 document 上（装没装上）；
 *   2. 手势判定语义（拦什么、放什么）；
 *   3. 端到端：拦下来之后真的派发了 `hermes-office-open`，且带对的绝对路径。
 *
 * 第 3 条是关键：只断言「函数返回 true」会漏掉「事件名写错 / 没派发」这类静默失效。
 */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_JS = join(HERE, '..', 'desktop', 'plugin.js')
const root = mkdtempSync(join(tmpdir(), 'office-viewer-patch-'))
const failures = []

function check(label, ok, detail = '') {
  if (ok) console.log(`  PASS  ${label}`)
  else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

/** 假的树行目标：`closest` 只认补丁真正会问的三个选择器。 */
function fakeTarget(title, { inTree = true } = {}) {
  const row = { getAttribute: name => (name === 'title' ? title : null) }

  return {
    closest(selector) {
      if (selector === '[data-project-tree] [title]') return inTree ? row : null
      if (selector === '[data-project-tree]') return inTree ? {} : null
      if (selector === '[title]') return inTree ? row : null

      return null
    }
  }
}

function fakeEvent(target, extra = {}) {
  return {
    target,
    detail: extra.detail === undefined ? 1 : extra.detail,
    altKey: !!extra.altKey,
    ctrlKey: !!extra.ctrlKey,
    metaKey: !!extra.metaKey,
    prevented: false,
    stopped: false,
    stoppedImmediate: false,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true },
    stopImmediatePropagation() { this.stoppedImmediate = true }
  }
}

try {
  // ---- 桩件 ---------------------------------------------------------------
  mkdirSync(join(root, 'node_modules', '@hermes', 'plugin-sdk'), { recursive: true })
  writeFileSync(
    join(root, 'node_modules', '@hermes', 'plugin-sdk', 'index.js'),
    [
      'const passthrough = (name) => (props = {}) => ({ $$component: name, props })',
      'export const Button = passthrough("Button")',
      'export const Codicon = passthrough("Codicon")',
      'export const Tip = passthrough("Tip")',
      'export const ScrollArea = passthrough("ScrollArea")',
      'export const cn = (...parts) => parts.filter(Boolean).join(" ")',
      'export const PANES_AREA = "panes"',
      'export const ROUTES_AREA = "routes"',
      'export const SIDEBAR_NAV_AREA = "sidebar.nav"',
      'export const PALETTE_AREA = "palette"',
      'export const KEYBINDS_AREA = "keybinds"',
      'export const TRANSCRIPT_DIRECTIVE_AREA = "transcript.directives"',
      'export const host = { notify: () => {}, revealPane: () => {}, openWorkspace: () => {} }',
      'export const useValue = (store) => store.get()',
      'export const atom = (initial) => { let value = initial; return { get: () => value, set: (next) => { value = next }, subscribe: () => () => {} } }'
    ].join('\n')
  )
  writeFileSync(
    join(root, 'node_modules', '@hermes', 'plugin-sdk', 'package.json'),
    JSON.stringify({ name: '@hermes/plugin-sdk', type: 'module', main: 'index.js' })
  )
  mkdirSync(join(root, 'node_modules', 'react'), { recursive: true })
  writeFileSync(
    join(root, 'node_modules', 'react', 'index.js'),
    [
      'export function useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}] }',
      'export function useEffect() {}',
      'export function useRef(value) { return { current: value === undefined ? null : value } }',
      'export function useCallback(fn) { return fn }',
      'export function useMemo(fn) { return fn() }'
    ].join('\n')
  )
  writeFileSync(
    join(root, 'node_modules', 'react', 'package.json'),
    JSON.stringify({
      name: 'react',
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js', './jsx-runtime': './jsx-runtime/index.js' }
    })
  )
  mkdirSync(join(root, 'node_modules', 'react', 'jsx-runtime'), { recursive: true })
  writeFileSync(
    join(root, 'node_modules', 'react', 'jsx-runtime', 'index.js'),
    'export function jsx(type, props, key) { return { type, props, key } }\nexport const jsxs = jsx\n'
  )
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  copyFileSync(PLUGIN_JS, join(root, 'plugin.mjs'))

  // 插件在 register 期就会碰 document / window，桩件必须先行。
  const windowListeners = []
  const dispatched = []
  globalThis.document = { nodeType: 9, addEventListener: () => {}, removeEventListener: () => {} }
  globalThis.window = {
    addEventListener: (type, listener) => { windowListeners.push({ type, listener }) },
    removeEventListener: () => {},
    dispatchEvent: event => { dispatched.push(event); return true }
  }
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init && init.detail
    }
  }

  // ---- 加载 ---------------------------------------------------------------
  const mod = await import(pathToFileURL(join(root, 'plugin.mjs')).href)
  const plugin = mod.default
  check('default export 存在', !!plugin)
  check('id 仍是 office-viewer（没被补丁改坏）', plugin?.id === 'office-viewer', String(plugin?.id))
  check('补丁标识存在', mod.PATCH_DBLCLICK === 'dblclick-interceptor-v1', String(mod.PATCH_DBLCLICK))

  // ---- 格式白名单：按内核真实能力取，不按 README 取 --------------------------
  const exts = mod.TREE_INTERCEPT_EXTS || []
  for (const ext of ['docx', 'doc', 'xlsx', 'xls', 'csv', 'pptx', 'ppt', 'wps', 'et', 'dps', 'ofd', 'rtf', 'md']) {
    check(`白名单含 ${ext}`, exts.includes(ext))
  }
  // 回归闸门：README 声称支持、但内核分派（ENGINE_EXTS）根本没接的格式不许进来，
  // 否则双击它们会落到查看器的「不支持」分支，比 core 的文本预览更差。
  for (const ext of ['odt', 'ods', 'docm', 'xlsm', 'pps', 'tsv', 'pages', 'numbers', 'epub', 'eml']) {
    check(`白名单不含（内核未接）${ext}`, !exts.includes(ext))
  }
  // 放过 core 自己就能处理的格式。
  for (const ext of ['png', 'jpg', 'pdf', 'html', 'htm', 'txt', 'json', 'py']) {
    check(`白名单不含（core 自己能看）${ext}`, !exts.includes(ext))
  }

  // ---- 纯函数边界 ---------------------------------------------------------
  check('isInterceptablePath 命中 docx', mod.isInterceptablePath('/a/b.docx') === true)
  check('isInterceptablePath 大小写不敏感', mod.isInterceptablePath('/a/b.DOCX') === true)
  check('isInterceptablePath 拒绝 odt', mod.isInterceptablePath('/a/b.odt') === false)
  check('isInterceptablePath 拒绝 pdf', mod.isInterceptablePath('/a/b.pdf') === false)
  check('isInterceptablePath 拒绝无扩展名', mod.isInterceptablePath('/a/b') === false)
  check('isInterceptablePath 拒绝空值', mod.isInterceptablePath('') === false)

  check('树行取到绝对路径', mod.treePathFromTarget(fakeTarget('/w/报表.xlsx')) === '/w/报表.xlsx')
  check('占位行（parent::placeholder）被拒', mod.treePathFromTarget(fakeTarget('parent::placeholder')) === '')
  check('相对路径被拒', mod.treePathFromTarget(fakeTarget('w/报表.xlsx')) === '')
  check('非白名单扩展名被拒', mod.treePathFromTarget(fakeTarget('/w/a.odt')) === '')
  check('树外元素被拒', mod.treePathFromTarget(fakeTarget('/w/a.docx', { inTree: false })) === '')
  check('null 目标不炸', mod.treePathFromTarget(null) === '')

  const okVerdict = mod.judgeTreeGesture(fakeTarget('/w/a.docx'), {})
  check('命中 → take=true', okVerdict.take === true && okVerdict.path === '/w/a.docx')
  const altVerdict = mod.judgeTreeGesture(fakeTarget('/w/a.docx'), { altKey: true })
  check('Alt → 放行', altVerdict.take === false && altVerdict.path === '/w/a.docx')
  const missVerdict = mod.judgeTreeGesture(fakeTarget('/w/a.odt'), {})
  check('树内非接管格式 → take=false', missVerdict.take === false && missVerdict.path === '')
  const outVerdict = mod.judgeTreeGesture(fakeTarget('/w/a.docx', { inTree: false }), {})
  check('树外 → take=false', outVerdict.take === false && outVerdict.info.inTree === false)
  // 假 DOM 自证：树外的目标绝不能同时被判成树内，否则上面的用例全是空转。
  check('假 DOM 自证：树外目标的 inTree 为假', mod.describeTreeTarget(fakeTarget('/w/a.docx', { inTree: false })).inTree === false)

  // ---- 注册：监听真的挂上了吗 ---------------------------------------------
  const contributions = []
  const domListeners = []
  const ctx = {
    source: 'plugin:office-viewer',
    register: c => { contributions.push(c); return () => {} },
    registerMany: list => { contributions.push(...list); return () => {} },
    onDispose: () => {},
    addEventListener: (target, type, listener, options) => {
      domListeners.push({ target, type, listener, options })

      return () => {}
    },
    rest: async () => ({}),
    os: {},
    storage: { get: () => null, set: () => {} }
  }

  plugin.register(ctx)

  const clickRec = domListeners.find(r => r.type === 'click')
  const dblRec = domListeners.find(r => r.type === 'dblclick')
  check('挂上了 document click 监听', !!clickRec && clickRec.target === globalThis.document)
  check('挂上了 document dblclick 监听', !!dblRec && dblRec.target === globalThis.document)
  check('click 用 capture 阶段', clickRec?.options === true)
  check('dblclick 用 capture 阶段', dblRec?.options === true)
  check('上游的 hermes-office-open 监听仍在（补丁没顶掉它）', windowListeners.some(l => l.type === 'hermes-office-open'))
  check('面板贡献仍注册（补丁没顶掉它）', contributions.some(c => c.area === 'panes'))

  // ---- 端到端：手势 → 派发 -------------------------------------------------
  const click = clickRec.listener
  const dbl = dblRec.listener

  const dblEvent = fakeEvent(fakeTarget('/w/报表.docx'), { detail: 2 })
  dbl(dblEvent)
  check('双击办公文件 → 被吞掉', dblEvent.prevented && dblEvent.stoppedImmediate)
  check('双击办公文件 → 派发了一次事件', dispatched.length === 1, `got ${dispatched.length}`)
  check('事件名是 hermes-office-open', dispatched[0]?.type === 'hermes-office-open', String(dispatched[0]?.type))
  check('事件带对的绝对路径', dispatched[0]?.detail?.path === '/w/报表.docx', String(dispatched[0]?.detail?.path))

  // 同一次双击的第二下（click detail=2）不许再开一次。
  const secondClick = fakeEvent(fakeTarget('/w/报表.docx'), { detail: 2 })
  click(secondClick)
  check('同一次双击不重复派发', dispatched.length === 1, `got ${dispatched.length}`)

  // 单击（detail=1）必须放过，否则行没法选中。
  const single = fakeEvent(fakeTarget('/w/报表.docx'), { detail: 1 })
  click(single)
  check('单击不拦（行仍可选中）', !single.prevented && dispatched.length === 1)

  // Alt+双击是逃生门。
  const altDbl = fakeEvent(fakeTarget('/w/报表.docx'), { detail: 2, altKey: true })
  dbl(altDbl)
  check('Alt+双击放行给官方', !altDbl.prevented && dispatched.length === 1)

  // 非接管格式放行。
  const odtDbl = fakeEvent(fakeTarget('/w/文档.odt'), { detail: 2 })
  dbl(odtDbl)
  check('odt 放行给官方', !odtDbl.prevented && dispatched.length === 1)

  // 树外元素放行。
  const outsideDbl = fakeEvent(fakeTarget('/w/报表.docx', { inTree: false }), { detail: 2 })
  dbl(outsideDbl)
  check('树外元素放行', !outsideDbl.prevented && dispatched.length === 1)

  // 换一个文件应该能再开一次。
  const otherDbl = fakeEvent(fakeTarget('/w/预算.xlsx'), { detail: 2 })
  dbl(otherDbl)
  check('换文件能再派发一次', dispatched.length === 2, `got ${dispatched.length}`)
  check('第二次派发路径正确', dispatched[1]?.detail?.path === '/w/预算.xlsx')
} catch (error) {
  failures.push(`抛出异常：${error && error.stack ? error.stack : error}`)
  console.log(`  FAIL  抛出异常：${error && error.stack ? error.stack : error}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过 ✓')
} else {
  console.log(`${failures.length} 项失败 ✗`)
  process.exitCode = 1
}
