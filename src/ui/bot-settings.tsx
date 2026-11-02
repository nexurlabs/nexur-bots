/**
 * One bot's settings: model, tools, skills, connected apps, memory, routines and safety. Every change is written
 * to that bot's own Hermes profile as soon as it's made, so there is no Save button to forget.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  $botConfig,
  APPROVAL_CHOICES,
  type Approvals,
  type BotConfig,
  isLoaded,
  loadBotConfig,
  loadProviders,
  patchConfig,
  type ProviderOption,
  REASONING_CHOICES,
  setApprovals,
  setMcp,
  setModel,
  setReasoning,
  setSkills,
  setToolsets,
  setWorkingFolder,
  appLabel,
  GROUPS_SERVER,
  THIS_PC_SERVER
} from '../lib/botconfig'
import { cleanError } from '../lib/native'
import { applyDefaultToLiveSessions } from '../lib/session-model'
import { $allBots } from '../lib/store'
import { Avatar } from './avatar'
import { Seg, Switch } from './controls'
import { Icon, type IconName } from './icons'
import { MemoryPane } from './memory'
import type { Routine } from '../lib/routines'
import { RoutinesPane } from './routines'

export type SettingsSection = 'apps' | 'memory' | 'model' | 'routines' | 'safety' | 'skills' | 'tools'

const SECTIONS: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: 'model', label: 'Model', icon: 'sparkle' },
  { id: 'tools', label: 'Tools', icon: 'tool' },
  { id: 'skills', label: 'Skills', icon: 'star' },
  { id: 'apps', label: 'Connected apps', icon: 'plug' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'routines', label: 'Routines', icon: 'clock' },
  { id: 'safety', label: 'Safety & folder', icon: 'shield' }
]

type Save = (work: () => Promise<unknown>) => Promise<boolean>

export function BotSettings({
  name,
  section,
  onClose,
  onShared,
  onNewRoutine,
  onEditRoutine
}: {
  name: string
  section?: SettingsSection
  onClose: () => void
  onShared: () => void
  onNewRoutine: () => void
  onEditRoutine: (routine: Routine) => void
}) {
  const bot = useStore($allBots).find(b => b.name === name) || null
  const state = useStore($botConfig)[name]
  const [active, setActive] = useState<SettingsSection>(section || 'model')
  const [status, setStatus] = useState<'' | 'saved' | 'saving'>('')
  const [error, setError] = useState('')
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void loadBotConfig(name, true)
  }, [name])

  useEffect(() => {
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)

    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const save: Save = async work => {
    setStatus('saving')
    setError('')

    try {
      await work()
      setStatus('saved')

      if (fade.current) {
        clearTimeout(fade.current)
      }

      fade.current = setTimeout(() => setStatus(''), 1600)

      return true
    } catch (err) {
      setStatus('')
      setError(cleanError(err))
      void loadBotConfig(name, true)

      return false
    }
  }

  const cfg = isLoaded(state) ? state : null

  return (
    <div className="sheet-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className="sheet settings" role="dialog">
        <div className="sheet-head">
          {bot ? <Avatar badge={false} bot={bot} size={40} /> : null}
          <div>
            <h2>{bot ? `${bot.display} settings` : 'Bot settings'}</h2>
            <p>Changes save straight to this bot's own Hermes profile.</p>
          </div>
          <span className="save-state" data-on={status || undefined}>
            {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''}
          </span>
          <button aria-label="Close" className="icon-btn sm ghost" onClick={onClose} type="button">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map(item => (
              <button data-on={item.id === active || undefined} key={item.id} onClick={() => setActive(item.id)} type="button">
                <Icon name={item.icon} size={16} />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="settings-pane" key={active}>
            {error ? <div className="banner bad">{error}</div> : null}
            {active === 'memory' ? (
              // Memory lives in files, not the config, so it doesn't wait for the config to load.
              <MemoryPane name={name} onShared={onShared} save={save} />
            ) : active === 'routines' ? (
              <RoutinesPane name={name} onEdit={onEditRoutine} onNew={onNewRoutine} save={save} />
            ) : !cfg ? (
              state && typeof state === 'object' && 'error' in state ? (
                <div className="panel-empty">
                  {state.error}{' '}
                  <button className="link-btn" onClick={() => void loadBotConfig(name, true)} type="button">
                    Try again
                  </button>
                </div>
              ) : (
                <div className="thread-loading">
                  <span className="spinner" />
                </div>
              )
            ) : active === 'model' ? (
              <ModelPane cfg={cfg} name={name} save={save} />
            ) : active === 'tools' ? (
              <ToolsPane cfg={cfg} name={name} save={save} />
            ) : active === 'skills' ? (
              <SkillsPane cfg={cfg} name={name} save={save} />
            ) : active === 'apps' ? (
              <AppsPane cfg={cfg} name={name} save={save} />
            ) : (
              <SafetyPane cfg={cfg} name={name} save={save} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface PaneProps {
  cfg: BotConfig
  name: string
  save: Save
}

function Pane({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="pane">
      <header>
        <h3>{title}</h3>
        {hint ? <p>{hint}</p> : null}
      </header>
      {children}
    </div>
  )
}

// ── model ─────────────────────────────────────────────────────────────────
/** The family a model belongs to: `claude-opus-5-5` → `claude-opus`, `gpt-4o` → `gpt`, `llama3.1:8b` → `llama`. */
export function modelFamily(model: string) {
  return model.replace(/[-_.:]?\d.*$/, '') || model
}

/** Models grouped by family, in the order the provider lists them. */
function groupModels(models: string[]) {
  const groups: { family: string; items: string[] }[] = []
  const at = new Map<string, number>()

  for (const model of models) {
    const family = modelFamily(model)
    const index = at.get(family)

    if (index === undefined) {
      at.set(family, groups.length)
      groups.push({ family, items: [model] })
    } else {
      groups[index].items.push(model)
    }
  }

  return groups
}

function ModelPane({ cfg, name, save }: PaneProps) {
  const [providers, setProviders] = useState<ProviderOption[] | null>(null)
  const [failed, setFailed] = useState('')
  const [slug, setSlug] = useState(cfg.model.provider)
  const [chosen, setChosen] = useState(cfg.model.model)
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState('')

  useEffect(() => {
    loadProviders(name)
      .then(list => {
        setProviders(list)
        setSlug(current => (list.some(p => p.slug === current) ? current : list.find(p => p.current)?.slug || list[0]?.slug || ''))
      })
      .catch(err => setFailed(cleanError(err)))
  }, [name])

  const provider = providers?.find(p => p.slug === slug)

  const models = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = provider?.models || []

    return (needle ? all.filter(m => m.toLowerCase().includes(needle)) : all).slice(0, 300)
  }, [provider, query])

  const dirty = Boolean(chosen) && (chosen !== cfg.model.model || slug !== cfg.model.provider)

  const apply = async (confirmed = false) => {
    await save(async () => {
      const result = await setModel(name, slug, chosen, confirmed)

      if (result.confirm) {
        setConfirm(result.confirm)
      } else {
        setConfirm('')
        // Chats already running switch now, not only after their session restarts.
        await applyDefaultToLiveSessions(name, { provider: slug, model: chosen })
      }
    })
  }

  return (
    <Pane hint="The AI model this bot thinks with. Each bot can use a different one." title="Model">
      <div className="now-card">
        <Icon name="sparkle" size={18} />
        <div>
          <b>{cfg.model.model || 'Hermes default'}</b>
          <small>{cfg.model.provider ? `via ${cfg.model.provider}` : 'No model pinned for this bot yet'}</small>
        </div>
      </div>
      <div className="field">
        <span>How hard it thinks</span>
        <Seg
          onChange={level =>
            void save(async () => {
              patchConfig(name, c => ({ ...c, reasoning: level }))
              await setReasoning(name, level)
            })
          }
          options={REASONING_CHOICES.map(choice => [choice.id, choice.label] as [string, string])}
          value={REASONING_CHOICES.some(choice => choice.id === cfg.reasoning.toLowerCase()) ? cfg.reasoning.toLowerCase() : ''}
        />
        <small>More thinking is slower and costs more, but helps on hard problems. Models that don't support it ignore this.</small>
      </div>
      {failed ? (
        <div className="panel-empty">Couldn't load the model list: {failed}</div>
      ) : !providers ? (
        <div className="panel-empty">Loading models…</div>
      ) : !providers.length ? (
        <div className="panel-empty">No providers are connected on this Hermes yet. Run `hermes model` there to add one.</div>
      ) : (
        <>
          <label className="field">
            <span>Provider</span>
            <select
              className="input"
              onChange={event => {
                setSlug(event.target.value)
                setQuery('')
              }}
              value={slug}
            >
              {providers.map(p => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                  {p.authenticated ? '' : ' (not connected)'}
                </option>
              ))}
            </select>
            {provider?.warning ? <small>{provider.warning}</small> : null}
          </label>
          <div className="field model-field">
            <span>Model</span>
            <input className="input model-search" onChange={event => setQuery(event.target.value)} placeholder={`Search ${provider?.models.length || 0} models`} value={query} />
            <div className="model-list">
              {groupModels(models).map(group => (
                <section className="model-group" key={group.family}>
                  <h5>
                    {group.family.replace(/-/g, ' ')}
                    <small>{group.items.length}</small>
                  </h5>
                  {group.items.map(model => {
                    const current = model === cfg.model.model && slug === cfg.model.provider

                    return (
                      <button aria-pressed={model === chosen} className="model-option" data-on={model === chosen || undefined} key={model} onClick={() => setChosen(model)} type="button">
                        <span className="model-name">{model}</span>
                        {current ? <em className="model-tag">current</em> : null}
                        <span className="model-check">{model === chosen ? <Icon name="check" size={14} /> : null}</span>
                      </button>
                    )
                  })}
                </section>
              ))}
              {!models.length ? <div className="panel-empty">No model matches “{query}”.</div> : null}
            </div>
          </div>
          {confirm ? (
            <div className="banner warn">
              <div className="banner-text">
                <b>Confirm this model</b>
                <span className="banner-hint">{confirm}</span>
              </div>
              <button className="btn sm" onClick={() => void apply(true)} type="button">
                Use it anyway
              </button>
            </div>
          ) : null}
          <div className="pane-actions model-footer">
            <small className="grow">{dirty ? `Switch to ${chosen}` : `Using ${cfg.model.model || 'Hermes default'}`}</small>
            <button className="btn primary" disabled={!dirty} onClick={() => void apply()} type="button">
              Use this model
            </button>
          </div>
        </>
      )}
    </Pane>
  )
}

// ── tools ─────────────────────────────────────────────────────────────────
function ToolsPane({ cfg, name, save }: PaneProps) {
  const enabledNames = cfg.toolsets.filter(t => t.enabled).map(t => t.name)

  const toggle = (toolset: string, on: boolean) => {
    const next = on ? [...enabledNames, toolset] : enabledNames.filter(n => n !== toolset)

    void save(async () => {
      patchConfig(name, c => ({ ...c, toolsetsPinned: true, toolsets: c.toolsets.map(t => (t.name === toolset ? { ...t, enabled: on } : t)) }))
      await setToolsets(name, next)
    })
  }

  return (
    <Pane
      hint={cfg.toolsetsPinned ? 'Groups of abilities this bot can use in a chat.' : 'Using Hermes defaults. Changing anything here gives this bot its own list.'}
      title="Tools"
    >
      <div className="rows">
        {cfg.toolsets.map(tool => (
          <div className="row" key={tool.name}>
            <div>
              <b>{tool.label}</b>
              {tool.description ? <small>{tool.description}</small> : null}
            </div>
            {tool.tool_count ? <span className="count">{tool.tool_count}</span> : null}
            <Switch checked={tool.enabled} label={tool.label} onChange={on => toggle(tool.name, on)} small />
          </div>
        ))}
        {!cfg.toolsets.length ? <div className="panel-empty">Hermes didn't list any tools for this bot.</div> : null}
      </div>
    </Pane>
  )
}

// ── skills ────────────────────────────────────────────────────────────────
function SkillsPane({ cfg, name, save }: PaneProps) {
  const [query, setQuery] = useState('')
  const on = cfg.skills.filter(s => s.enabled).map(s => s.name)

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return [...cfg.skills].sort((a, b) => a.name.localeCompare(b.name)).filter(s => !needle || s.name.toLowerCase().includes(needle))
  }, [cfg.skills, query])

  const apply = (enabled: string[]) =>
    void save(async () => {
      const set = new Set(enabled)
      patchConfig(name, c => ({ ...c, skills: c.skills.map(s => ({ ...s, enabled: set.has(s.name) })) }))
      await setSkills(name, cfg.skills, enabled)
    })

  return (
    <Pane hint={`${on.length} of ${cfg.skills.length} skills are on. Skills are saved know-how the bot can pull in when a task calls for it.`} title="Skills">
      <div className="pane-tools">
        <input className="input" onChange={event => setQuery(event.target.value)} placeholder="Search skills" value={query} />
        <button className="btn sm ghost" onClick={() => apply(cfg.skills.map(s => s.name))} type="button">
          All on
        </button>
        <button className="btn sm ghost" onClick={() => apply([])} type="button">
          All off
        </button>
      </div>
      <div className="rows">
        {shown.map(skill => (
          <div className="row" key={skill.name}>
            <div>
              <b>{skill.name}</b>
            </div>
            <Switch checked={skill.enabled} label={skill.name} onChange={next => apply(next ? [...on, skill.name] : on.filter(n => n !== skill.name))} small />
          </div>
        ))}
        {!shown.length ? <div className="panel-empty">{cfg.skills.length ? `No skill matches “${query}”.` : 'No skills are installed for this bot.'}</div> : null}
      </div>
    </Pane>
  )
}

// ── connected apps ────────────────────────────────────────────────────────
function AppsPane({ cfg, name, save }: PaneProps) {
  const on = cfg.mcp.filter(s => s.enabled).map(s => s.name)

  const toggle = (server: string, next: boolean) =>
    void save(async () => {
      const enabled = next ? [...on, server] : on.filter(n => n !== server)
      patchConfig(name, c => ({ ...c, mcp: c.mcp.map(s => (s.name === server ? { ...s, enabled: next } : s)) }))
      await setMcp(name, enabled)
    })

  return (
    <Pane hint="Apps and services this bot can reach through MCP servers on your Hermes." title="Connected apps">
      <div className="rows">
        {cfg.mcp.map(server => {
          const pc = server.name === THIS_PC_SERVER
          const groups = server.name === GROUPS_SERVER

          return (
            <div className="row" key={server.name}>
              <div>
                <b>{appLabel(server.name)}</b>
                <small>
                  {pc
                    ? 'Lets this bot see and control your computer while you allow it, from the This PC tab.'
                    : groups
                      ? 'Lets this bot post into its group chats and change its own name, label and description when you ask it to in your 1:1 chat. Runs inside this app.'
                      : `${server.transport} server`}
                </small>
              </div>
              <Switch checked={server.enabled} label={server.name} onChange={next => toggle(server.name, next)} small />
            </div>
          )
        })}
        {!cfg.mcp.length ? (
          <div className="panel-empty">
            No apps are connected to this bot. Add one on the Hermes machine with <code>hermes mcp add</code> and it will show up here.
          </div>
        ) : null}
      </div>
    </Pane>
  )
}

// ── safety & folder ───────────────────────────────────────────────────────
function SafetyPane({ cfg, name, save }: PaneProps) {
  const [folder, setFolder] = useState(cfg.cwd)

  useEffect(() => setFolder(cfg.cwd), [cfg.cwd])

  return (
    <Pane hint="How much freedom this bot has, and where it works." title="Safety & folder">
      <div className="field">
        <span>Before running commands</span>
        {cfg.approvals === 'unknown' ? (
          <small className="warn">Hermes has an unrecognised approval mode ({cfg.approvalsRaw ?? '?'}). Pick one below to set it.</small>
        ) : null}
        <div className="radio-cards">
          {APPROVAL_CHOICES.map(choice => (
            <button
              aria-checked={cfg.approvals === choice.id}
              data-on={cfg.approvals === choice.id || undefined}
              key={choice.id}
              onClick={() =>
                void save(async () => {
                  patchConfig(name, c => ({ ...c, approvals: choice.id as Approvals }))
                  await setApprovals(name, choice.id)
                })
              }
              role="radio"
              type="button"
            >
              <b>{choice.label}</b>
              <small>{choice.hint}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Working folder</span>
        <div className="inline-field">
          <input className="input" onChange={event => setFolder(event.target.value)} placeholder="Hermes' own default folder" value={folder} />
          <button className="btn" disabled={!folder.trim() || folder.trim() === cfg.cwd} onClick={() => void save(() => setWorkingFolder(name, folder.trim()))} type="button">
            Save
          </button>
        </div>
        <small>A folder on the machine Hermes runs on, where this bot's commands start and its files land.</small>
      </div>
    </Pane>
  )
}
