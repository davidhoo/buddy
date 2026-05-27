import { useCallback, useEffect, useState } from 'react'
import {
  Language,
  LanguagePref,
  SendShortcut,
  TranslationKey,
  detectLanguage,
  resolveLanguage,
  translate
} from '../lib/i18n'

const LANGUAGE_KEY = 'buddy.language'
const SEND_SHORTCUT_KEY = 'buddy.sendShortcut'
const LANGUAGE_EVENT = 'buddy.language-change'
const SEND_SHORTCUT_EVENT = 'buddy.sendShortcut-change'

function getStoredValue(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage?.getItem(key) ?? null
  } catch { return null }
}

function setStoredValue(key: string, value: string) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage?.setItem(key, value)
  } catch {}
}

function dispatchWindowEvent(eventName: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(eventName))
  }
}

function readLanguagePref(): LanguagePref {
  const v = getStoredValue(LANGUAGE_KEY)
  if (v === 'auto' || v === 'zh-CN' || v === 'zh-TW' || v === 'en') return v
  return 'auto'
}

function readSendShortcut(): SendShortcut {
  const v = getStoredValue(SEND_SHORTCUT_KEY)
  if (v === 'enter' || v === 'shift-enter' || v === 'cmd-enter') return v
  return 'shift-enter'
}

function writeLanguagePref(pref: LanguagePref) {
  setStoredValue(LANGUAGE_KEY, pref)
  dispatchWindowEvent(LANGUAGE_EVENT)
}

function writeSendShortcut(value: SendShortcut) {
  setStoredValue(SEND_SHORTCUT_KEY, value)
  dispatchWindowEvent(SEND_SHORTCUT_EVENT)
}

function useLocalStorageBacked<T>(read: () => T, eventName: string): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(read)
  useEffect(() => {
    const handler = () => setValue(read())
    window.addEventListener(eventName, handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener(eventName, handler)
      window.removeEventListener('storage', handler)
    }
  }, [eventName, read])
  return [value, setValue]
}

export function useLanguagePref(): {
  pref: LanguagePref
  language: Language
  setPref: (pref: LanguagePref) => void
  detected: Language
} {
  const [pref] = useLocalStorageBacked(readLanguagePref, LANGUAGE_EVENT)
  const setPref = useCallback((next: LanguagePref) => writeLanguagePref(next), [])
  return {
    pref,
    language: resolveLanguage(pref),
    detected: detectLanguage(),
    setPref
  }
}

export function useLanguage(): Language {
  return useLanguagePref().language
}

export type TFunction = (key: TranslationKey, params?: Record<string, string | number>) => string

export function useT(): TFunction {
  const language = useLanguage()
  return useCallback(
    (key, params) => translate(language, key, params),
    [language]
  )
}

export function useSendShortcut(): {
  shortcut: SendShortcut
  setShortcut: (value: SendShortcut) => void
} {
  const [shortcut] = useLocalStorageBacked(readSendShortcut, SEND_SHORTCUT_EVENT)
  const setShortcut = useCallback((value: SendShortcut) => writeSendShortcut(value), [])
  return { shortcut, setShortcut }
}
