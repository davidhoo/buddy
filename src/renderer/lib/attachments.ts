import { FileText, FileCode2, File, FileJson, FileArchive, FileSpreadsheet, Image as ImageIcon } from 'lucide-react'
import type { Attachment } from '../../shared/types'

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

export const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', csv: 'text/csv',
}

export const EXT_ICON_MAP: Record<string, typeof File> = {
  json: FileJson, zip: FileArchive, tar: FileArchive, gz: FileArchive, rar: FileArchive, '7z': FileArchive,
  csv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet,
  ts: FileCode2, tsx: FileCode2, js: FileCode2, jsx: FileCode2,
  py: FileCode2, go: FileCode2, rs: FileCode2, rb: FileCode2,
  java: FileCode2, c: FileCode2, cpp: FileCode2, h: FileCode2,
  swift: FileCode2, kt: FileCode2,
  md: FileText, txt: FileText, rtf: FileText,
  doc: FileText, docx: FileText, pdf: FileText,
  xml: FileText, yaml: FileText, yml: FileText, toml: FileText,
  png: ImageIcon, jpg: ImageIcon, jpeg: ImageIcon, gif: ImageIcon,
  webp: ImageIcon, svg: ImageIcon, bmp: ImageIcon, ico: ImageIcon,
}

export function fileExt(name: string): string {
  return name.split('.').pop()?.toUpperCase() ?? ''
}

export function isImageAttachment(att: Attachment): boolean {
  if (att.category === 'image' || att.mimeType.startsWith('image/')) return true
  if (!att.mimeType) {
    const ext = att.name.split('.').pop()?.toLowerCase() ?? ''
    if (IMAGE_EXTS.has(ext)) return true
  }
  return false
}

export function fileIconForName(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_ICON_MAP[ext] ?? File
}

export function mimeTypeForExt(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_MAP[ext] ?? 'application/octet-stream'
}

export function ensureMimeType(att: Attachment): string {
  if (att.mimeType) return att.mimeType
  const ext = att.name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_MAP[ext] ?? 'application/octet-stream'
}

export function generateAttachmentId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}
