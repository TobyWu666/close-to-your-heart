import './style.css'
import {
  DrawingUtils,
  FilesetResolver,
  HandLandmarker,
} from '@mediapipe/tasks-vision'

const SCORE_TO_PLAY = 0.7
const SCORE_PARTS = [
  ['pairedContacts', '雙接點成立'],
  ['indexContact', '食指尖接點'],
  ['thumbContact', '拇指尖接點'],
  ['verticalHeart', '拇指在下方'],
  ['sameHandOpenAngle', '單手張角'],
  ['otherFingersAway', '其他手指排除'],
]
const HEART_VIDEO_SRC = `${import.meta.env.BASE_URL}heart.mov`
const AGENT_PROMPT = `請幫我建立一個名為「貼近你的心」的互動網頁。

核心概念：
使用者開啟網頁後，網站會啟用 webcam，偵測兩隻手是否正在比愛心。當愛心手勢信心度超過 70% 時，播放指定影片；低於 70% 時，影片要立刻暫停、回到開頭並隱藏。

技術架構：
1. 使用 Vite + vanilla JavaScript，不需要 React。
2. 使用 @mediapipe/tasks-vision 的 HandLandmarker。
3. 使用 navigator.mediaDevices.getUserMedia() 開啟鏡頭。
4. HandLandmarker 設定 numHands: 2，同時偵測兩隻手。
5. 每幀使用 detectForVideo(video, performance.now()) 取得 landmarks。
6. 使用 canvas 疊在 video 上，畫出手部骨架。
7. 影片素材放在 public/heart.mov，使用 Vite 的 base path 載入，例如 \`\${import.meta.env.BASE_URL}heart.mov\`。

愛心手勢判斷：
MediaPipe 每隻手有 21 個 landmarks，主要使用：
- 0：手腕
- 4：拇指尖
- 8：食指尖
- 12：中指尖
- 16：無名指尖
- 20：小指尖

請寫一個 scoreHardcodedGesture(hands) 函式，回傳 0 到 1 的信心度。判斷重點：
1. 必須同時偵測到兩隻手。
2. 左右食指尖要點對點靠近。
3. 左右拇指尖也要點對點靠近。
4. 拇指接點要在食指接點下方。
5. 中指、無名指、小指不能也一起形成主要接點，避免攤開雙手誤判。
6. 所有距離要除以手掌大小 scale，避免手靠近或遠離鏡頭時分數飄移。

播放邏輯：
const SCORE_TO_PLAY = 0.7

if (score >= SCORE_TO_PLAY) {
  video.classList.add("is-playing")
  video.play()
} else {
  video.classList.remove("is-playing")
  video.pause()
  video.currentTime = 0
}

UI 需求：
1. 網頁標題是「貼近你的心」。
2. 上方是互動 demo，不要滿版，要保留頁面邊距。
3. 影片播放時用 50% 透明度疊在鏡頭上。
4. 左上角顯示即時信心度百分比。
5. 加一個「啟用聲音」按鈕，因為瀏覽器通常會擋掉未經使用者互動的有聲自動播放。
6. 下方做成部落格式長文教學，不要只是幾張卡片。
7. 教學內容要包含系統流程、landmarks 編號、分數公式、播放閘門、調參方式。
8. 加一個「給 AI agent 的實作 prompt」區塊，內含這份 prompt，並提供 copy 按鈕。

驗收標準：
1. npm run build 必須成功。
2. 開啟頁面後會自動要求相機權限。
3. 雙手比愛心且信心度超過 70% 時，影片會半透明播放。
4. 手勢低於 70% 時，影片立刻停止並回到開頭。
5. Copy prompt 按鈕可正常複製 prompt。`

let handLandmarker
let drawingUtils
let cameraStream
let animationId
let lastVideoTime = -1
let audioUnlocked = false
let latestScore = 0

document.querySelector('#app').innerHTML = `
  <main class="page">
    <section class="demo-section">
      <div class="demo-copy">
        <p class="eyebrow">Hand Gesture Trigger</p>
        <h1>貼近你的心</h1>
        <p>鏡頭會即時偵測兩隻手的手指關節，當愛心手勢信心度超過 70% 時播放影片，低於門檻就立刻停止。</p>
        <button id="audioButton" class="sound-button" type="button">啟用聲音</button>
      </div>

      <div class="stage">
        <video id="camera" autoplay muted playsinline></video>
        <canvas id="overlay"></canvas>
        <video id="funnyVideo" class="funny-video" src="${HEART_VIDEO_SRC}" playsinline preload="auto" loop muted></video>
        <div class="confidence">
          <span>信心度</span>
          <strong id="scoreText">--%</strong>
        </div>
      </div>
    </section>

    <article class="blog">
      <header class="blog-header">
        <p class="eyebrow">How It Works</p>
        <h2>這個網站如何判斷你正在比愛心</h2>
        <p>這不是在辨識「愛心」這個詞，也不是拿圖片去比對圖片。它做的是一件更直接的事：把兩隻手轉成 42 個座標點，然後用幾何規則判斷這些點是不是形成愛心手勢。</p>
      </header>

      <section class="blog-section">
        <h3>1. 即時分數拆解</h3>
        <p>下面每一條都會跟著你的鏡頭畫面即時更新。真正重要的是「雙接點成立」：左右食指尖要靠近，左右拇指尖也要靠近。只有其中一組靠近，或只是兩隻手攤開，都不應該拿到高分。</p>
        <div id="breakdown" class="breakdown"></div>
      </section>

      <section class="blog-section">
        <h3>2. 系統流程</h3>
        <p>整個流程分成四層。第一層拿到鏡頭畫面，第二層把手轉成 landmarks，第三層計算手勢分數，最後一層只負責控制影片播放。</p>
        <div class="flow">
          <div><strong>Camera</strong><span>瀏覽器用 getUserMedia 取得 webcam 影像。</span></div>
          <div><strong>HandLandmarker</strong><span>MediaPipe 每幀輸出最多兩隻手，各 21 個關節點。</span></div>
          <div><strong>Gesture Score</strong><span>用指尖距離、上下關係、其他手指距離算出 0 到 1 的分數。</span></div>
          <div><strong>Video Gate</strong><span>分數達 70% 就播放，低於 70% 立刻暫停並歸零。</span></div>
        </div>
      </section>

      <section class="blog-section">
        <h3>3. 手部 landmarks 怎麼看</h3>
        <p>MediaPipe 的手部模型會把一隻手標成 21 個點。這個網站不是全部平均使用，而是挑出最能代表愛心形狀的幾個點。</p>
        <div class="landmark-grid">
          <div><b>0</b><span>手腕，用來排序左右手，也用來估算手的大小。</span></div>
          <div><b>4</b><span>拇指尖。左右拇指尖靠近時，形成愛心下方接點。</span></div>
          <div><b>8</b><span>食指尖。左右食指尖靠近時，形成愛心上方接點。</span></div>
          <div><b>12</b><span>中指尖。用來排除「中指也碰在一起」的誤判。</span></div>
          <div><b>16</b><span>無名指尖。用來確認其他手指沒有一起變成接點。</span></div>
          <div><b>20</b><span>小指尖。用來避免攤開手時被錯判成愛心。</span></div>
        </div>
      </section>

      <section class="blog-section">
        <h3>4. 愛心分數怎麼算</h3>
        <p>分數不是單一條件，而是多個小分數加權。權重最高的是兩組點對點接觸：食指尖接食指尖、拇指尖接拇指尖。</p>
        <pre><code>const indexGap = distance(leftIndexTip, rightIndexTip) / scale
const thumbGap = distance(leftThumbTip, rightThumbTip) / scale

const indexContact = scoreContact(indexGap)
const thumbContact = scoreContact(thumbGap)
const pairedContacts = Math.min(indexContact, thumbContact)</code></pre>
        <p><code>Math.min(indexContact, thumbContact)</code> 很關鍵。它代表兩個接點必須同時成立；如果只有食指靠近、拇指沒有靠近，核心分數還是會被壓低。</p>
      </section>

      <section class="blog-section">
        <h3>5. 為什麼要除以 scale</h3>
        <p>同一個手勢，手離鏡頭近會變大，離鏡頭遠會變小。如果直接用螢幕座標距離，分數會忽高忽低。所以程式先用手腕到幾個指根的平均距離估算手掌大小，再把所有距離除以這個大小。</p>
        <pre><code>function handScale(hand) {
  return average([
    distance(hand[0], hand[5]),
    distance(hand[0], hand[9]),
    distance(hand[0], hand[13]),
    distance(hand[0], hand[17]),
  ])
}</code></pre>
      </section>

      <section class="blog-section">
        <h3>6. 影片閘門</h3>
        <p>最後的播放邏輯故意做得很硬：超過門檻就播放，低於門檻就切掉。這樣使用者會立刻感覺到手勢是否成立。</p>
        <pre><code>const score = scoreHardcodedGesture(hands)

if (score >= 0.7) {
  video.play()
} else {
  video.pause()
  video.currentTime = 0
}</code></pre>
      </section>

      <section class="blog-section">
        <h3>7. 調整準確度時看哪裡</h3>
        <p>如果太容易觸發，先把 <code>scoreContact()</code> 的容忍範圍縮小，或把 <code>SCORE_TO_PLAY</code> 從 <code>0.7</code> 調高。如果太難觸發，就放寬 <code>scoreContact()</code> 的最大距離，或降低「其他手指排除」的權重。</p>
        <pre><code>const SCORE_TO_PLAY = 0.7

function scoreContact(gap) {
  return scoreNearZero(gap, 0.42, 1.18)
}</code></pre>
      </section>

      <section class="blog-section">
        <h3>8. 聲音為什麼要先點按鈕</h3>
        <p>Safari 和 Chrome 通常不允許網頁在沒有使用者操作的情況下自動播放有聲影片。所以頁面提供「啟用聲音」按鈕，讓使用者先完成一次互動。之後手勢觸發影片時，就可以帶聲音播放。</p>
      </section>

      <section class="blog-section prompt-section">
        <div class="prompt-heading">
          <div>
            <h3>9. 給 AI agent 的實作 prompt</h3>
            <p>如果你想請另一個 AI agent 重做或延伸這個網站，可以直接複製下面這段。它已經把目前的技術架構、手勢判斷、UI 與驗收條件整理好。</p>
          </div>
          <button id="copyPromptButton" class="copy-button" type="button">複製 prompt</button>
        </div>
        <textarea id="agentPrompt" class="prompt-box" readonly>${escapeHTML(AGENT_PROMPT)}</textarea>
      </section>
    </article>
  </main>
`

const camera = document.querySelector('#camera')
const canvas = document.querySelector('#overlay')
const scoreText = document.querySelector('#scoreText')
const funnyVideo = document.querySelector('#funnyVideo')
const audioButton = document.querySelector('#audioButton')
const breakdown = document.querySelector('#breakdown')
const copyPromptButton = document.querySelector('#copyPromptButton')
const agentPrompt = document.querySelector('#agentPrompt')
const canvasContext = canvas.getContext('2d')

drawingUtils = new DrawingUtils(canvasContext)
window.addEventListener('resize', syncCanvasSize)
audioButton.addEventListener('click', unlockAudio)
copyPromptButton.addEventListener('click', copyAgentPrompt)
renderBreakdown(Object.fromEntries(SCORE_PARTS.map(([key]) => [key, 0])))

startCamera()

async function startCamera() {
  try {
    handLandmarker ||= await createHandLandmarker()
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user',
      },
      audio: false,
    })

    camera.srcObject = cameraStream
    await camera.play()
    syncCanvasSize()
    detectLoop()
  } catch (error) {
    console.error(error)
    scoreText.textContent = 'ERR'
  }
}

async function createHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
  )

  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
  })
}

function detectLoop() {
  if (!handLandmarker || camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    animationId = requestAnimationFrame(detectLoop)
    return
  }

  if (camera.currentTime !== lastVideoTime) {
    lastVideoTime = camera.currentTime
    const now = performance.now()
    const result = handLandmarker.detectForVideo(camera, now)
    const hands = result.landmarks || []
    const score = hands.length >= 2 ? scoreHardcodedGesture(hands) : 0

    drawHands(hands)
    if (hands.length < 2) {
      renderBreakdown(Object.fromEntries(SCORE_PARTS.map(([key]) => [key, 0])))
    }
    updateScore(score)
    updatePlayback(score)
  }

  animationId = requestAnimationFrame(detectLoop)
}

function drawHands(hands) {
  canvasContext.clearRect(0, 0, canvas.width, canvas.height)

  for (const hand of hands) {
    drawingUtils.drawConnectors(hand, HandLandmarker.HAND_CONNECTIONS, {
      color: '#69e3b6',
      lineWidth: 4,
    })
    drawingUtils.drawLandmarks(hand, {
      color: '#f8d765',
      radius: 4,
    })
  }
}

function updatePlayback(score) {
  if (score >= SCORE_TO_PLAY) {
    funnyVideo.classList.add('is-playing')

    if (funnyVideo.paused) {
      funnyVideo.currentTime = 0
      funnyVideo.play().catch(() => {
        audioButton.classList.add('needs-click')
      })
    }

    return
  }

  funnyVideo.classList.remove('is-playing')

  if (!funnyVideo.paused || funnyVideo.currentTime > 0) {
    funnyVideo.pause()
    funnyVideo.currentTime = 0
  }
}

function scoreHardcodedGesture(hands) {
  const [firstHand, secondHand] = hands
    .slice(0, 2)
    .sort((a, b) => a[0].x - b[0].x)
  const leftIndexTip = firstHand[8]
  const rightIndexTip = secondHand[8]
  const leftThumbTip = firstHand[4]
  const rightThumbTip = secondHand[4]
  const leftMiddleTip = firstHand[12]
  const rightMiddleTip = secondHand[12]
  const leftRingTip = firstHand[16]
  const rightRingTip = secondHand[16]
  const leftPinkyTip = firstHand[20]
  const rightPinkyTip = secondHand[20]
  const leftWrist = firstHand[0]
  const rightWrist = secondHand[0]
  const scale = average([handScale(firstHand), handScale(secondHand)])
  const wristGap = distance(leftWrist, rightWrist) / scale
  const indexGap = distance(leftIndexTip, rightIndexTip) / scale
  const thumbGap = distance(leftThumbTip, rightThumbTip) / scale
  const middleGap = distance(leftMiddleTip, rightMiddleTip) / scale
  const ringGap = distance(leftRingTip, rightRingTip) / scale
  const pinkyGap = distance(leftPinkyTip, rightPinkyTip) / scale
  const indexY = (leftIndexTip.y + rightIndexTip.y) / 2
  const thumbY = (leftThumbTip.y + rightThumbTip.y) / 2
  const centerX = (leftWrist.x + rightWrist.x) / 2
  const indexCenterX = (leftIndexTip.x + rightIndexTip.x) / 2
  const thumbCenterX = (leftThumbTip.x + rightThumbTip.x) / 2
  const verticalGap = (thumbY - indexY) / scale
  const indexContact = scoreContact(indexGap)
  const thumbContact = scoreContact(thumbGap)
  const pairedContacts = Math.min(indexContact, thumbContact)
  const sameHandOpenAngle = scoreWithinRange(
    average([
      distance(leftIndexTip, leftThumbTip) / scale,
      distance(rightIndexTip, rightThumbTip) / scale,
    ]),
    1.1,
    3.1
  )
  const verticalHeart = scoreWithinRange(verticalGap, 0.35, 2.2)
  const otherFingersAway = scoreOtherFingersAway(
    [middleGap, ringGap, pinkyGap],
    Math.max(indexGap, thumbGap)
  )
  const contactCentersAligned = scoreCentered(indexCenterX, thumbCenterX, scale)
  const parts = {
    pairedContacts,
    indexContact,
    thumbContact,
    verticalHeart,
    sameHandOpenAngle,
    otherFingersAway,
    wristGap: scoreWristGap(wristGap),
    indexCentered: scoreCentered(indexCenterX, centerX, scale),
    thumbCentered: scoreCentered(thumbCenterX, centerX, scale),
    contactCentersAligned,
  }

  const score = weightedAverage([
    [pairedContacts, 0.36],
    [indexContact, 0.12],
    [thumbContact, 0.12],
    [verticalHeart, 0.14],
    [sameHandOpenAngle, 0.1],
    [otherFingersAway, 0.08],
    [parts.wristGap, 0.04],
    [parts.indexCentered, 0.02],
    [parts.thumbCentered, 0.02],
    [contactCentersAligned, 0.04],
  ])

  renderBreakdown(parts)
  return score
}

function handScale(hand) {
  return average([
    distance(hand[0], hand[5]),
    distance(hand[0], hand[9]),
    distance(hand[0], hand[13]),
    distance(hand[0], hand[17]),
  ])
}

function scoreNearZero(gap, perfectUntil, maxGap) {
  if (gap <= perfectUntil) return 1
  return 1 - clamp((gap - perfectUntil) / (maxGap - perfectUntil))
}

function scoreContact(gap) {
  return scoreNearZero(gap, 0.42, 1.18)
}

function scoreWithinRange(value, min, max) {
  const center = (min + max) / 2
  const halfRange = (max - min) / 2
  return 1 - clamp(Math.abs(value - center) / halfRange)
}

function scoreOtherFingersAway(gaps, contactGap) {
  const smallestOtherGap = Math.min(...gaps)
  return clamp((smallestOtherGap - contactGap - 0.45) / 1.15)
}

function scoreWristGap(wristGap) {
  return scoreWithinRange(wristGap, 1.6, 5.2)
}

function scoreCentered(pointX, centerX, scale) {
  return 1 - clamp(Math.abs(pointX - centerX) / (scale * 0.9))
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0))
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function weightedAverage(items) {
  const totalWeight = items.reduce((sum, [, weight]) => sum + weight, 0)
  return items.reduce((sum, [value, weight]) => sum + clamp(value) * weight, 0) / totalWeight
}

function clamp(value, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max)
}

function syncCanvasSize() {
  const rect = camera.getBoundingClientRect()
  canvas.width = Math.max(1, Math.round(rect.width))
  canvas.height = Math.max(1, Math.round(rect.height))
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`
  canvasContext.setTransform(1, 0, 0, 1, 0, 0)
}

function updateScore(score) {
  latestScore = score
  const percent = Math.round(clamp(score) * 100)
  scoreText.textContent = `${percent}%`
  document.documentElement.style.setProperty('--score', clamp(score))
}

function unlockAudio() {
  audioUnlocked = true
  funnyVideo.muted = false
  funnyVideo.volume = 1
  audioButton.textContent = '聲音已啟用'
  audioButton.classList.remove('needs-click')
  audioButton.classList.add('is-on')

  if (latestScore >= SCORE_TO_PLAY) {
    funnyVideo.play().catch(() => {
      audioButton.textContent = '再點一次啟用聲音'
      audioButton.classList.add('needs-click')
    })
    return
  }

  funnyVideo.play()
    .then(() => {
      funnyVideo.pause()
      funnyVideo.currentTime = 0
    })
    .catch(() => {
      audioUnlocked = false
      audioButton.textContent = '再點一次啟用聲音'
      audioButton.classList.add('needs-click')
    })
}

function renderBreakdown(parts) {
  breakdown.innerHTML = SCORE_PARTS.map(([key, label]) => {
    const value = clamp(parts[key] || 0)
    const percent = Math.round(value * 100)

    return `
      <div class="score-row">
        <div class="score-label">
          <span>${label}</span>
          <strong>${percent}%</strong>
        </div>
        <div class="score-bar"><span style="transform: scaleX(${value})"></span></div>
      </div>
    `
  }).join('')
}

async function copyAgentPrompt() {
  try {
    await navigator.clipboard.writeText(agentPrompt.value)
    setCopyButtonState('已複製')
  } catch {
    agentPrompt.focus()
    agentPrompt.select()
    document.execCommand('copy')
    setCopyButtonState('已複製')
  }
}

function setCopyButtonState(label) {
  const originalLabel = '複製 prompt'
  copyPromptButton.textContent = label
  copyPromptButton.classList.add('is-copied')

  window.setTimeout(() => {
    copyPromptButton.textContent = originalLabel
    copyPromptButton.classList.remove('is-copied')
  }, 1600)
}

function escapeHTML(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(animationId)
  cameraStream?.getTracks().forEach((track) => track.stop())
})
