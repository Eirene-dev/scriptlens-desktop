// Fixed facts of the app. No Electron import — tests read this too.

export const APP_NAME = 'ScriptLens';
export const APP_ID = 'ai.mindvest.scriptlens';

/** the page the main window shows; the bridge works only under this path of this origin */
export const DEFAULT_LAB_URL = 'https://lab.mindvest.ai/scriptlens';
export const LAB_PATH = '/scriptlens';

export const REPO = 'Eirene-dev/scriptlens-desktop';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
export const LATEST_JSON_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`;

/** the lab page's storage (its own documents) and the hidden YouTube page's — never the same */
export const LAB_PARTITION = 'persist:scriptlens-lab';
export const YT_PARTITION = 'persist:scriptlens-youtube';
