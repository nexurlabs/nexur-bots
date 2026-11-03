/**
 * This PC tab — real computer use on the user's own machine (screenshots + mouse/keyboard),
 * the Grok/Claude-style "computer use" feature. Unlike the sandbox tab, there's nothing to
 * stream here: it's the user's own screen, they can already see it. This panel is the
 * permission switch — off by default every time the app starts — plus a glance at the last
 * thing a bot looked at, and the one-key panic stop (Ctrl+Alt+Esc, from anywhere).
 *
 * Wire contract: electron/local-computer.cjs runs a small MCP server and registers it with
 * the gateway as `hermes-bots-this-pc` whenever connected; every tool call it answers checks
 * the same `granted` flag this panel flips.
 *
 * Open shows the last screenshot large (same overlay as the sandbox view). It is a picture,
 * not a stream, and it is your own screen, so there is no control to hand over: Allow /
 * Stop, the per-action approvals and Ctrl+Alt+Esc are unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { useStore } from '@nanostores/react'

import { refreshBotTools } from '../lib/chat'
import { $computerDemo } from '../lib/computer-demo'
import { native } from '../lib/native'
import { toast } from '../lib/store'
import { Icon } from './icons'
import { type Dot, ScreenOverlay, StatusDot } from './screen-overlay'

interface ComputerState {
  running: boolean
  port: number
  granted: boolean
  lastError?: string
}

export function ThisPcTab({ profile = 'default' }: { profile?: string }) {
  const [state, setState] = useState<ComputerState | null>(null)
  const [busy, setBusy] = useState(false)
  const [shot, setShot] = useState<null | { dataUrl: string; at: number }>(null)
  const [link, setLink] = useState<'checking' | { ok: boolean; tools: number; error: string; asks: boolean }>('checking')
  const [open, setOpen] = useState(false)
  const [ratio, setRatio] = useState(16 / 9)
  const demoView = useStore($computerDemo)
  const isDemo = demoView?.mode === 'thispc'

  // Design preview: control on, a stand-in screenshot, nothing asks Electron.
  useEffect(() => {
    if (!demoView || demoView.mode !== 'thispc') return
    setState({ running: true, port: 0, granted: true })
    setShot({ dataUrl: demoView.screen, at: Date.now() - 4000 })
    setLink({ ok: true, tools: 8, error: '', asks: true })
    setOpen(demoView.open)
  }, [demoView])

  const checkLink = () => {
    if ($computerDemo.get()) return
    setLink('checking')
    void native
      .computerCheck(profile)
      .then(result => mounted.current && setLink({ ok: result.ok, tools: result.tools.length, error: result.error, asks: result.asks === true }))
      .catch(error => mounted.current && setLink({ ok: false, tools: 0, error: String(error?.message || error), asks: false }))
  }

  useEffect(checkLink, [profile])
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    if ($computerDemo.get()) return () => void (mounted.current = false)
    void native.computerGetState().then(s => mounted.current && setState(s))
    const off = native.onComputerGrantedChanged(granted => {
      if (!mounted.current) return
      setState(s => (s ? { ...s, granted } : s))
    })

    return () => {
      mounted.current = false
      off()
    }
  }, [])

  // While control is on, poll the last screenshot.
  useEffect(() => {
    if (!state?.granted || isDemo) return undefined
    const shotTimer = setInterval(() => {
      void native.computerGetLastShot().then(s => mounted.current && setShot(s))
    }, 2000)
    void native.computerGetLastShot().then(s => mounted.current && setShot(s))

    return () => {
      clearInterval(shotTimer)
    }
  }, [isDemo, state?.granted])

  // Turning control off (here, from Settings, or with Ctrl+Alt+Esc) closes the large view too.
  useEffect(() => {
    if (state && !state.granted) setOpen(false)
  }, [state])

  const closeView = useCallback(() => setOpen(false), [])

  const toggle = async () => {
    if (!state) return
    setBusy(true)

    try {
      const next = await native.computerSetGranted(!state.granted)
      setState(next)

      if (!next.granted) {
        setShot(null)
      } else {
        // Chats that were already open need a nudge to see the PC tools.
        void refreshBotTools().then(ok => toast(ok ? 'Bots can use this PC now. Ask one to take a screenshot.' : 'Control is on. If a bot says it cannot see your PC, start a new chat with it.'))
      }
    } finally {
      setBusy(false)
    }
  }

  if (native.platform !== 'win32' && !isDemo) {
    return (
      <div className="computer-card">
        <b>This PC isn't available here</b>
        <p>Real computer control currently works on Windows only, to match the machine this app is installed on.</p>
      </div>
    )
  }

  if (!state) {
    return <div className="panel-empty">Checking…</div>
  }

  const dot: { tone: Dot; title: string } = state.granted
    ? { tone: 'you', title: `Control is on${shot ? ` · last screenshot ${new Date(shot.at).toLocaleTimeString()}` : ''}. Ctrl+Alt+Esc turns it off.` }
    : { tone: 'off', title: 'Control is off' }

  return (
    <div className="computer this-pc" style={{ '--ar': String(ratio) } as React.CSSProperties}>
      <div className="this-pc-preview" data-active={state.granted || undefined} data-demo-hover={demoView?.hover || undefined}>
        {state.granted && shot ? (
          <img
            alt="Last thing a bot looked at on this screen"
            onLoad={e => e.currentTarget.naturalHeight && setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
            src={shot.dataUrl}
          />
        ) : null}
        {!(state.granted && shot) ? (
          <span className="this-pc-placeholder">
            <Icon name="computer" size={16} />
            {state.granted ? 'Waiting for a bot to look at your screen' : null}
          </span>
        ) : null}
        {state.granted && shot ? <div aria-hidden="true" className="computer-hit" onClick={() => setOpen(true)} /> : null}
        <div className="screen-bar">
          <StatusDot {...dot} />
        </div>
        {state.granted && shot ? (
          <button className="computer-open" onClick={() => setOpen(true)} title="Show the last screenshot large" type="button">
            <Icon name="expand" size={14} /> Open
          </button>
        ) : null}
      </div>

      {open && shot ? (
        <ScreenOverlay dot={dot} label="Last screenshot of this PC" onClose={closeView} ratio={ratio}>
          <img alt="Last thing a bot looked at on this screen" className="this-pc-large" src={shot.dataUrl} />
        </ScreenOverlay>
      ) : null}

      <div className="computer-actions">
        <button
          className={`btn ${state.granted ? 'danger-solid' : 'primary'}`}
          disabled={busy}
          onClick={() => void toggle()}
          title={state.granted ? 'Stops bots using this PC. Ctrl+Alt+Esc does the same from anywhere.' : 'Let bots see and use this PC'}
          type="button"
        >
          {busy ? <span className="spinner xs" /> : <Icon name={state.granted ? 'stop' : 'shield'} size={14} />}
          {state.granted ? 'Stop' : 'Allow'}
        </button>
      </div>

      {link !== 'checking' && !link.ok ? (
        <div className="link-check" data-bad>
          <i />
          <span>Hermes can't reach this PC. {link.error}</span>
          <button className="link-btn" onClick={checkLink} type="button">
            Retry
          </button>
        </div>
      ) : null}

      <p className="this-pc-note">
        Looking at the screen runs straight away. NexurBots asks on this PC before each click, keystroke or other action. Hermes may also ask in the chat.
      </p>

      {link !== 'checking' && link.ok && !link.asks ? (
        <div className="link-check" data-bad>
          <i />
          <span>Hermes couldn't be set to ask in chat. NexurBots will still ask on this PC before each action.</span>
          <button className="link-btn" onClick={checkLink} type="button">
            Retry
          </button>
        </div>
      ) : null}

      {state.lastError ? <div className="banner bad">{state.lastError}</div> : null}
    </div>
  )
}
