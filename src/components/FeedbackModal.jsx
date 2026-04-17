import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import { Modal } from './UI'
import styles from './FeedbackModal.module.css'

const MAX_SCREENSHOT_SIZE = 8 * 1024 * 1024
const APP_VERSION = '0.1.0'

function collectDeviceInfo() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  return {
    app_version: APP_VERSION,
    url: window.location.href,
    user_agent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      dpr: window.devicePixelRatio,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    online: navigator.onLine,
    touch_points: navigator.maxTouchPoints,
    device_memory: navigator.deviceMemory ?? null,
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    connection: conn
      ? { effective_type: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt }
      : null,
    pwa: window.matchMedia('(display-mode: standalone)').matches,
    prefers_dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    prefers_reduced_motion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    recent_errors: window.__arcaneErrors?.slice() ?? [],
  }
}

const safeFileName = (fileName) =>
  fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'screenshot.png'

export default function FeedbackModal({ onClose }) {
  const { user } = useAuth()
  const fileInputRef = useRef(null)
  const [type, setType] = useState('bug')
  const [description, setDescription] = useState('')
  const [contact, setContact] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [doneMessage, setDoneMessage] = useState("Your feedback has been received. I'll review it shortly.")
  const [submitError, setSubmitError] = useState('')
  const [fileError, setFileError] = useState('')
  const [screenshot, setScreenshot] = useState(null)

  const clearScreenshot = () => {
    setScreenshot(null)
    setFileError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleScreenshotChange = (event) => {
    const file = event.target.files?.[0]
    setFileError('')

    if (!file) {
      setScreenshot(null)
      return
    }

    if (!file.type.startsWith('image/')) {
      setScreenshot(null)
      setFileError('Please choose an image file.')
      event.target.value = ''
      return
    }

    if (file.size > MAX_SCREENSHOT_SIZE) {
      setScreenshot(null)
      setFileError('Screenshots must be 8 MB or smaller.')
      event.target.value = ''
      return
    }

    setScreenshot(file)
  }

  const handleSubmit = async () => {
    if (!description.trim() || fileError) return

    setSubmitting(true)
    setSubmitError('')

    try {
      const { data: feedback, error: feedbackError } = await sb
        .from('feedback')
        .insert({
          type,
          description: description.trim(),
          contact: contact.trim() || null,
          user_id: user?.id || null,
          user_email: user?.email || null,
          device_info: collectDeviceInfo(),
        })
        .select('id')
        .single()

      if (feedbackError) throw feedbackError

      let nextDoneMessage = "Your feedback has been received. I'll review it shortly."

      if (screenshot) {
        if (!user?.id) {
          nextDoneMessage = 'Your feedback was sent, but the screenshot was skipped because uploads require a signed-in account.'
        } else {
          const fileExt = screenshot.name.includes('.')
            ? screenshot.name.split('.').pop()?.toLowerCase() || 'png'
            : 'png'
          const normalizedName = screenshot.name || `screenshot.${fileExt}`
          const fileKey = `feedback/${user.id}/${feedback.id}-${Date.now()}-${safeFileName(normalizedName)}`

          const { error: uploadError } = await sb.storage
            .from('assets')
            .upload(fileKey, screenshot, {
              cacheControl: '3600',
              upsert: false,
              contentType: screenshot.type || 'image/png',
            })

          if (uploadError) {
            console.error('feedback screenshot upload:', uploadError)
            nextDoneMessage = 'Your feedback was sent, but the screenshot upload failed.'
          } else {
            const { error: attachmentError } = await sb.from('feedback_attachments').insert({
              feedback_id: feedback.id,
              user_id: user.id,
              user_email: user.email || null,
              file_key: fileKey,
              mime_type: screenshot.type || 'image/png',
              file_size: screenshot.size,
              file_name: normalizedName,
            })

            if (attachmentError) {
              console.error('feedback attachment insert:', attachmentError)
              nextDoneMessage = 'Your feedback was sent, but the screenshot could not be linked.'
            }
          }
        }
      }

      clearScreenshot()
      setDoneMessage(nextDoneMessage)
      setDone(true)
    } catch (err) {
      console.error('feedback submit:', err)
      setSubmitError('Could not send feedback right now. Please try again.')
    }

    setSubmitting(false)
  }

  if (done) {
    return (
      <Modal onClose={onClose}>
        <div className={styles.doneWrap}>
          <div className={styles.doneIcon}>✓</div>
          <h2 className={styles.doneTitle}>Thanks!</h2>
          <p className={styles.doneSub}>{doneMessage}</p>
          <button className={styles.doneBtn} onClick={onClose}>Close</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal onClose={onClose}>
      <div className={styles.titleRow}>
        <span className={styles.titleIcon}>{type === 'bug' ? '🐞' : '✦'}</span>
        <h2 className={styles.title}>
          {type === 'bug' ? 'Report a Bug' : 'Request a Feature'}
        </h2>
      </div>

      <div className={styles.typeRow}>
        <button
          type="button"
          className={`${styles.typeBtn} ${type === 'bug' ? styles.typeBtnActive : ''}`}
          onClick={() => setType('bug')}
        >
          <span className={styles.typeBtnIcon}>🐞</span>
          <span>Bug Report</span>
        </button>
        <button
          type="button"
          className={`${styles.typeBtn} ${type === 'feature' ? styles.typeBtnActive : ''}`}
          onClick={() => setType('feature')}
        >
          <span className={styles.typeBtnIcon}>✦</span>
          <span>Feature Request</span>
        </button>
      </div>

      <label className={styles.label}>
        {type === 'bug' ? 'What went wrong?' : 'What would you like to see?'}
        <span className={styles.required}> *</span>
      </label>
      <textarea
        className={styles.textarea}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder={
          type === 'bug'
            ? 'Describe what happened and how to reproduce it...'
            : 'Describe the feature and why it would be useful...'
        }
        rows={5}
        maxLength={2000}
      />
      <div className={styles.charCount}>{description.length}/2000</div>

      <label className={styles.label}>
        Screenshot <span className={styles.optional}>(optional)</span>
      </label>
      <div className={styles.uploadBlock}>
        <input
          ref={fileInputRef}
          className={styles.uploadInput}
          type="file"
          accept="image/*"
          onChange={handleScreenshotChange}
          disabled={!user}
        />
        <button
          type="button"
          className={styles.uploadBtn}
          onClick={() => fileInputRef.current?.click()}
          disabled={!user}
        >
          {screenshot ? 'Replace Screenshot' : 'Upload Screenshot'}
        </button>
        {screenshot ? (
          <div className={styles.fileRow}>
            <div className={styles.fileMeta}>
              <span className={styles.fileName}>{screenshot.name}</span>
              <span className={styles.fileSize}>{(screenshot.size / 1024 / 1024).toFixed(2)} MB</span>
            </div>
            <button type="button" className={styles.fileRemoveBtn} onClick={clearScreenshot}>
              Remove
            </button>
          </div>
        ) : null}
      </div>
      <p className={styles.uploadHint}>
        {user
          ? 'Attach a screenshot to help reproduce the issue or explain the request.'
          : 'Sign in to attach a screenshot.'}
      </p>
      {fileError ? <p className={styles.errorText}>{fileError}</p> : null}

      <label className={styles.label}>
        Discord or Email <span className={styles.optional}>(optional)</span>
      </label>
      <input
        className={styles.input}
        type="text"
        placeholder="your#1234 or you@email.com"
        value={contact}
        onChange={(event) => setContact(event.target.value)}
        maxLength={120}
      />
      <p className={styles.contactHint}>So I can follow up with you if needed.</p>
      <p className={styles.disclosure}>
        Feedback submissions include your message, your signed-in account email if available, optional contact
        details, optional screenshot uploads, and browser/device diagnostics to help reproduce the issue. Read
        more in the <Link to="/privacy" className={styles.disclosureLink} onClick={onClose}>Privacy Policy</Link>.
      </p>
      {submitError ? <p className={styles.errorText}>{submitError}</p> : null}

      <div className={styles.actions}>
        <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
        <button
          className={styles.submitBtn}
          onClick={handleSubmit}
          disabled={submitting || !description.trim() || !!fileError}
        >
          {submitting ? 'Sending...' : 'Send Feedback'}
        </button>
      </div>
    </Modal>
  )
}
