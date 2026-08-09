import { useRef, useState } from 'react'
import { ImportIcon } from '../../icons'
import styles from './ImportSourceStep.module.css'
import uiStyles from '../UI.module.css'

const TAB_LABELS = { text: 'Paste List', file: 'Upload File', url: 'From URL' }

/**
 * Where an import comes from: pasted text, an uploaded file, or a deck URL.
 *
 * Identical work on both sides of the app, so it lives here rather than twice.
 * Callers declare which sources they accept via `sources` — the collection
 * import and the builder import take the same three, but a caller that can't
 * use one just leaves it out and the tab bar sizes itself.
 */
export default function ImportSourceStep({
  sources = ['text', 'file'],
  tab,
  onTabChange,
  text,
  onTextChange,
  url = '',
  onUrlChange,
  onUrlSubmit,
  textHint = null,
  textPlaceholder = '',
  urlHint = null,
  urlPlaceholder = '',
  busy = false,
}) {
  const fileRef = useRef(null)
  const [dragover, setDragover] = useState(false)
  const [fileError, setFileError] = useState('')
  const activeIndex = Math.max(0, sources.indexOf(tab))

  const readFile = (file) => {
    if (!file) return
    if (!/\.(csv|txt)$/i.test(file.name || '')) {
      setFileError('Use a .csv or .txt file.')
      return
    }
    setFileError('')
    const reader = new FileReader()
    reader.onload = ev => onTextChange(String(ev.target.result || ''))
    reader.onerror = () => setFileError('Could not read that file. Try again or paste the list instead.')
    reader.readAsText(file)
  }

  const lineCount = text ? text.split('\n').filter(Boolean).length : 0

  return (
    <>
      {sources.length > 1 && (
        <div
          className={styles.tabs}
          role="tablist"
          style={{ '--tab-count': sources.length, '--tab-index': activeIndex }}
        >
          {sources.map(id => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`${styles.tab} ${tab === id ? styles.tabActive : ''}`}
              onClick={() => onTabChange(id)}
            >
              {TAB_LABELS[id]}
            </button>
          ))}
        </div>
      )}

      {tab === 'text' && (
        <div className={styles.pane}>
          {textHint}
          <textarea
            autoFocus
            className={styles.textarea}
            value={text}
            onChange={e => onTextChange(e.target.value)}
            placeholder={textPlaceholder}
            rows={10}
          />
        </div>
      )}

      {tab === 'file' && (
        <div className={`${styles.pane} ${text ? '' : styles.paneCentered}`}>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            style={{ display: 'none' }}
            onChange={e => { readFile(e.target.files?.[0]); e.target.value = '' }}
          />
          {/* Same drop target as the empty states on /decks, /binders and
              /lists — one way to hand the app a file, wherever you are. */}
          <button
            type="button"
            className={`${uiStyles.libraryImport} ${dragover ? uiStyles.libraryImportDragover : ''} ${styles.dropZone}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragover(true) }}
            onDragLeave={() => setDragover(false)}
            onDrop={e => { e.preventDefault(); setDragover(false); readFile(e.dataTransfer.files?.[0]) }}
          >
            <span className={uiStyles.libraryImportIcon}><ImportIcon size={22} /></span>
            <span className={uiStyles.libraryImportCopy}>
              <strong>{text ? 'File loaded' : 'Choose a file'}</strong>
              <span>
                {text
                  ? `${lineCount} line${lineCount === 1 ? '' : 's'} ready — drop another to replace it`
                  : 'Drop a .csv or .txt here, or click to browse'}
              </span>
            </span>
            <span className={uiStyles.libraryImportArrow} aria-hidden="true">›</span>
          </button>
          {fileError && <p className={styles.fileError} role="alert">{fileError}</p>}
          {text && <textarea readOnly className={styles.filePreview} value={text} rows={6} />}
        </div>
      )}

      {tab === 'url' && (
        <div className={`${styles.pane} ${styles.paneCentered}`}>
          {urlHint}
          <input
            autoFocus
            type="url"
            className={styles.urlInput}
            value={url}
            onChange={e => onUrlChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && url.trim() && !busy) onUrlSubmit?.() }}
            placeholder={urlPlaceholder}
          />
        </div>
      )}
    </>
  )
}
