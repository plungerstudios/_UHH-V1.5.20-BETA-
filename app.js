const DB_NAME = 'uhh-local-chat';
const DB_VERSION = 1;
const CHAT_STORE = 'chats';
const IMAGE_STORE = 'images';
const IMAGE_BUCKET = 'chat-images';
const TERMS_VERSION = '2026-11-17-photo-storage';
const MODE_PROMPTS = {
  casual: 'Use a natural, friendly, conversational tone. Be clear and helpful without sounding stiff.',
  formal: 'Use a polished, respectful, professional tone. Keep the response well-structured and precise.',
  expert: 'Use careful, in-depth reasoning to produce an accurate, thoughtful response. Explain important assumptions and useful nuance, but do not reveal private chain-of-thought; give a concise rationale instead.'
};

const state = {
  db: null,
  chats: [],
  currentChatId: null,
  mode: 'casual',
  busy: false,
  settings: { name: '', instructions: '' },
  supabase: null,
  session: null,
  activeUserId: null,
  authGeneration: 0,
  authConfigured: false,
  authError: '',
  authMessage: '',
  authBusy: false,
  pendingImage: null,
  lastSyncErrorAt: 0,
  syncInProgress: false,
  outageVisible: false,
  toastTimer: null
};

const $ = (selector) => document.querySelector(selector);
const welcome = $('#welcome');
const messageList = $('#messageList');
const input = $('#messageInput');
const sendButton = $('#sendButton');

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHAT_STORE)) database.createObjectStore(CHAT_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(IMAGE_STORE)) database.createObjectStore(IMAGE_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local chat storage.'));
  });
}

function dbRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    if (!state.db) {
      reject(new Error('Local chat storage is unavailable.'));
      return;
    }
    let transaction;
    let request;
    try {
      transaction = state.db.transaction(storeName, mode);
      request = action(transaction.objectStore(storeName));
    } catch (error) {
      reject(error);
      return;
    }
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error('Could not access local chat storage.'));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('Local chat storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Local chat storage transaction failed.'));
  });
}

async function saveChat(chat) {
  const userId = state.session?.user?.id;
  if (userId) chat.syncUserId = userId;
  const record = localChatRecord(chat);
  await dbRequest(CHAT_STORE, 'readwrite', (store) => store.put(record));
  if (userId) {
    try {
      await uploadChatImages(chat, userId);
      await dbRequest(CHAT_STORE, 'readwrite', (store) => store.put(localChatRecord(chat)));
      await upsertCloudChat(chat, userId);
    } catch (error) {
      console.error('Could not sync chat:', error);
      try {
        await dbRequest(CHAT_STORE, 'readwrite', (store) => store.put(localChatRecord(chat)));
      } catch (localError) {
        console.error('Could not save synced photo paths locally:', localError);
      }
      if (Date.now() - state.lastSyncErrorAt > 10_000) {
        showToast('Saved on this device, but cloud sync failed. Check your connection and sign in again.');
        state.lastSyncErrorAt = Date.now();
      }
    }
  }
}

function localChatRecord(chat) {
  return {
    id: chat.id,
    title: chat.title,
    updatedAt: chat.updatedAt,
    mode: chat.mode,
    syncUserId: chat.syncUserId || null,
    messages: chat.messages
      .filter((message) => !message.pending)
      .map(({ id, role, content, imageId, imagePath, imageMissing, error }) => ({
        id,
        role,
        content,
        imageId,
        imagePath,
        imageMissing,
        error
      }))
  };
}

function getImage(id) {
  return dbRequest(IMAGE_STORE, 'readonly', (store) => store.get(id));
}

function getAllChats() {
  return dbRequest(CHAT_STORE, 'readonly', (store) => store.getAll());
}

function releaseImageUrls(chats) {
  chats.forEach((chat) => {
    chat.messages.forEach((message) => {
      if (message.imageUrl) URL.revokeObjectURL(message.imageUrl);
    });
  });
}

async function uploadChatImages(chat, userId) {
  if (!state.supabase || state.session?.user?.id !== userId) {
    throw new Error('Sign in again before syncing photos.');
  }
  for (const message of chat.messages || []) {
    if (!message.imageId || message.imagePath) continue;
    const stored = await getImage(message.imageId);
    if (!stored?.blob) throw new Error('A photo for this chat is missing from this device.');
    const path = `${userId}/${chat.id}/${message.id}.jpg`;
    const { error } = await state.supabase.storage
      .from(IMAGE_BUCKET)
      .upload(path, stored.blob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw new Error(error.message || 'Could not upload a chat photo.');
    message.imagePath = path;
  }
}

async function removeCloudImages(chat, userId) {
  const paths = [...new Set((chat.messages || []).map((message) => message.imagePath).filter(Boolean))];
  if (!paths.length) return;
  const { error } = await state.supabase.storage.from(IMAGE_BUCKET).remove(paths);
  if (error) throw new Error(error.message || 'Could not delete the synced chat photos.');
}

async function upsertCloudChat(chat, userId, deleted = false) {
  if (!deleted) await uploadChatImages(chat, userId);
  const row = {
    user_id: userId,
    chat_id: chat.id,
    title: chat.title || 'New chat',
    updated_at: new Date(chat.updatedAt).toISOString(),
    mode: Object.hasOwn(MODE_PROMPTS, chat.mode) ? chat.mode : 'casual',
    messages: deleted ? [] : chat.messages
      .filter((message) => !message.pending)
      .map(({ id, role, content, imageId, imagePath, imageMissing, error }) => ({
        id,
        role: role === 'model' ? 'assistant' : role,
        content,
        hasImage: Boolean(imageId || imagePath || imageMissing),
        imagePath: imagePath || null,
        error: Boolean(error)
      })),
    deleted
  };
  const { error } = await state.supabase
    .from('chat_histories')
    .upsert(row, { onConflict: 'user_id,chat_id' });
  if (error) throw new Error(error.message || 'Cloud chat sync failed.');
}

function fromCloudChat(remote, local) {
  const localMessages = new Map((local?.messages || []).map((message) => [message.id, message]));
  return {
    id: remote.chat_id,
    title: remote.title,
    updatedAt: Date.parse(remote.updated_at),
    mode: remote.mode,
    syncUserId: remote.user_id,
    messages: (remote.messages || []).map((message) => {
      const localMessage = localMessages.get(message.id);
      const imageId = localMessage?.imageId;
      return {
        id: message.id,
        role: message.role === 'assistant' ? 'model' : message.role,
        content: message.content,
        imageId,
        imagePath: message.imagePath || localMessage?.imagePath,
        imageMissing: Boolean(message.hasImage && !imageId && !message.imagePath),
        error: Boolean(message.error)
      };
    })
  };
}

async function syncChatsForUser(userId, offerLegacyImport = true) {
  const localChats = await getAllChats();
  const ownedChats = localChats.filter((chat) => chat.syncUserId === userId);
  const unclaimedChats = localChats.filter((chat) => !chat.syncUserId);
  let importedChats = [];
  if (offerLegacyImport && unclaimedChats.length && window.confirm(
    `This browser has ${unclaimedChats.length} older local chat${unclaimedChats.length === 1 ? '' : 's'}. ` +
    'Add them to this verified account? Chat text and any photos will be uploaded to your account.'
  )) {
    importedChats = unclaimedChats.map((chat) => ({ ...chat, syncUserId: userId }));
    for (const chat of importedChats) {
      await dbRequest(CHAT_STORE, 'readwrite', (store) => store.put(chat));
    }
  } else if (offerLegacyImport && unclaimedChats.length) {
    showToast('Older chats remain on this device and were not uploaded.');
  }

  const { data: remoteChats, error } = await state.supabase
    .from('chat_histories')
    .select('*');
  if (error) throw new Error(error.message || 'Could not load cloud chats.');

  const localById = new Map([...ownedChats, ...importedChats].map((chat) => [chat.id, chat]));
  const remoteById = new Map(remoteChats.map((chat) => [chat.chat_id, chat]));
  const chatIds = new Set([...localById.keys(), ...remoteById.keys()]);

  for (const chatId of chatIds) {
    const local = localById.get(chatId);
    const remote = remoteById.get(chatId);
    const remoteUpdatedAt = remote ? Date.parse(remote.updated_at) : 0;
    if (remote && (
      !local
      || remoteUpdatedAt > local.updatedAt
      || remote.deleted && remoteUpdatedAt === local.updatedAt
    )) {
      if (remote.deleted) {
        if (local) await removeChatRecord(chatId);
        continue;
      }
      const merged = fromCloudChat(remote, local);
      await dbRequest(CHAT_STORE, 'readwrite', (store) => store.put(merged));
      continue;
    }
    if (local) {
      local.syncUserId = userId;
      await upsertCloudChat(local, userId);
      await dbRequest(CHAT_STORE, 'readwrite', (store) => store.put(localChatRecord(local)));
    }
  }

  await loadChatsForUser(userId);
}

async function refreshCloudChats() {
  const userId = state.session?.user?.id;
  if (!userId || state.syncInProgress || document.hidden) return;
  const generation = state.authGeneration;
  state.syncInProgress = true;
  try {
    await syncChatsForUser(userId, false);
    if (generation !== state.authGeneration || state.session?.user?.id !== userId) return;
    renderAll();
  } catch (error) {
    console.error('Could not refresh cloud chats:', error);
    if (Date.now() - state.lastSyncErrorAt > 10_000) {
      showToast('Could not refresh chats from your account. Your local chats are still available.');
      state.lastSyncErrorAt = Date.now();
    }
  } finally {
    if (generation === state.authGeneration) state.syncInProgress = false;
  }
}

function removeChatRecord(id) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction([CHAT_STORE, IMAGE_STORE], 'readwrite');
    const chatRequest = transaction.objectStore(CHAT_STORE).get(id);
    chatRequest.onsuccess = () => {
      const chat = chatRequest.result;
      transaction.objectStore(CHAT_STORE).delete(id);
      if (chat) {
        chat.messages.forEach((message) => {
          if (message.imageId) transaction.objectStore(IMAGE_STORE).delete(message.imageId);
        });
      }
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Could not delete this chat.'));
    transaction.onabort = () => reject(transaction.error || new Error('Could not delete this chat.'));
  });
}

function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(`uhh-preferences:${state.session.user.id}`) || '{}');
    state.settings = {
      name: typeof saved.name === 'string' ? saved.name.slice(0, 40) : '',
      instructions: typeof saved.instructions === 'string' ? saved.instructions.slice(0, 800) : ''
    };
  } catch (error) {
    console.error('Could not read personalization settings:', error);
    showToast('Saved personalization could not be read. You can set it again in Personalization.');
  }
}

function updateGate() {
  const signedIn = Boolean(state.session);
  const acceptedTerms = localStorage.getItem('uhh-terms-accepted') === TERMS_VERSION;
  if (state.session?.user?.email) $('#emailInput').value = state.session.user.email;
  $('#welcomeGate').hidden = signedIn && acceptedTerms;
  const authMessage = $('#authMessage');
  authMessage.textContent = state.authError || state.authMessage;
  authMessage.classList.toggle('error', Boolean(state.authError));
  $('#emailInput').disabled = signedIn || state.authBusy;
  $('#continueButton').textContent = signedIn ? 'Continue to _UHH' : 'Send sign-in link';
  $('#continueButton').disabled = !state.authConfigured
    || state.authBusy
    || !$('#emailInput').checkValidity()
    || !$('#termsCheckbox').checked;
  $('#signOutButton').hidden = !signedIn;
}

async function continueWithEmail(event) {
  event.preventDefault();
  const emailInput = $('#emailInput');
  const termsCheckbox = $('#termsCheckbox');
  if (!emailInput.reportValidity() || !termsCheckbox.checked) return;

  const email = emailInput.value.trim().toLowerCase();
  if (!state.authConfigured || !state.supabase) {
    state.authError = 'Cloud sign-in is not set up yet. You can enter your email, but _UHH cannot send a sign-in link until Supabase is configured.';
    updateGate();
    return;
  }
  try {
    localStorage.setItem('uhh-terms-accepted', TERMS_VERSION);
  } catch (error) {
    console.error('Could not save terms acceptance:', error);
    state.authError = 'Your terms acceptance could not be saved in this browser.';
    updateGate();
    return;
  }
  if (state.session) {
    state.authMessage = '';
    updateGate();
    return;
  }
  state.authBusy = true;
  state.authError = '';
  state.authMessage = '';
  updateGate();
  try {
    const { error } = await state.supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    });
    if (error) throw error;
    state.authMessage = `A sign-in link was sent to ${email}. Open it in this browser to continue.`;
  } catch (error) {
    console.error('Could not send sign-in link:', error);
    state.authError = error.message || 'Could not send a sign-in link. Please try again.';
  } finally {
    state.authBusy = false;
  }
  updateGate();
}

async function signOut() {
  try {
    const { error } = await state.supabase.auth.signOut();
    if (error) throw error;
    showToast('Signed out. Your cloud chats remain in your account.');
  } catch (error) {
    console.error('Could not sign out:', error);
    showToast('Could not sign out. Please try again.');
  }
}

async function activateSession(session) {
  state.session = session;
  const userId = session?.user?.id || null;
  if (userId === state.activeUserId) {
    updateProfile();
    updateGate();
    return;
  }
  const generation = ++state.authGeneration;
  state.activeUserId = userId;
  if (state.pendingImage) {
    URL.revokeObjectURL(state.pendingImage.url);
    state.pendingImage = null;
    renderAttachmentPreview();
    updateSendButton();
  }
  if (!userId) {
    releaseImageUrls(state.chats);
    state.chats = [];
    state.currentChatId = null;
    state.settings = { name: '', instructions: '' };
    state.syncInProgress = false;
    renderAll();
    updateProfile();
    updateGate();
    return;
  }

  releaseImageUrls(state.chats);
  state.chats = [];
  state.currentChatId = null;
  state.settings = { name: '', instructions: '' };
  readPreferences();
  renderAll();
  updateProfile();
  updateGate();
  state.syncInProgress = true;
  try {
    await syncChatsForUser(userId);
  } catch (error) {
    console.error('Could not sync cloud chats:', error);
    showToast('Signed in, but cloud chat sync failed. Your saved local chats are still safe.');
    try {
      await loadChatsForUser(userId);
    } catch (loadError) {
      console.error('Could not load local chats:', loadError);
    }
  } finally {
    if (generation === state.authGeneration) state.syncInProgress = false;
  }
  if (generation !== state.authGeneration || state.session?.user?.id !== userId) return;
  renderAll();
  updateProfile();
  updateGate();
}

async function initializeSupabase() {
  const response = await fetch('/api/auth-config');
  if (!response.ok) throw new Error('Cloud sign-in configuration could not be loaded.');
  const config = await response.json();
  if (!config.configured) {
    state.authError = 'Cloud sign-in has not been configured by _UHH yet.';
    updateGate();
    return;
  }
  await loadSupabaseSdk();
  state.supabase = window.supabase.createClient(config.url, config.anonKey);
  state.authConfigured = true;
  const { data, error } = await state.supabase.auth.getSession();
  if (error) throw error;
  state.supabase.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => {
      activateSession(session).catch((sessionError) => {
        console.error('Could not update signed-in session:', sessionError);
        showToast('Your account session could not be updated. Please refresh the page.');
      });
    }, 0);
  });
  await activateSession(data.session);
}

function loadSupabaseSdk() {
  if (window.supabase?.createClient) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    script.onload = () => {
      if (window.supabase?.createClient) resolve();
      else reject(new Error('The secure sign-in library could not be loaded.'));
    };
    script.onerror = () => reject(new Error('The secure sign-in library could not be loaded. Check your internet connection.'));
    document.head.append(script);
  });
}

function savePreferences() {
  state.settings = {
    name: $('#nameInput').value.trim().slice(0, 40),
    instructions: $('#instructionsInput').value.trim().slice(0, 800)
  };
  localStorage.setItem(`uhh-preferences:${state.session.user.id}`, JSON.stringify(state.settings));
  localStorage.setItem('uhh-mode', state.mode);
  updateProfile();
  closeSettings();
  showToast('Your preferences are saved in this browser.');
}

function updateProfile() {
  const name = state.settings.name || state.session?.user?.email || 'Just you';
  $('#profileName').textContent = name;
  $('#accountStatus').textContent = state.session ? 'Verified email · cloud sync' : 'Sign in to sync chats';
  $('#welcomeName').textContent = state.settings.name ? `${state.settings.name}, what’s on your mind?` : 'what’s on your mind?';
  $('#nameInput').value = state.settings.name;
  $('#instructionsInput').value = state.settings.instructions;
}

function setMode(mode) {
  if (!Object.hasOwn(MODE_PROMPTS, mode)) return;
  state.mode = mode;
  document.querySelectorAll('.mode-button').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  localStorage.setItem('uhh-mode', mode);
  const chat = currentChat();
  if (chat) {
    chat.mode = mode;
    chat.updatedAt = Date.now();
    saveChat(chat).catch((error) => {
      console.error('Could not save chat style:', error);
      showToast('The chat style changed, but could not be saved to this device.');
    });
  }
}

function currentChat() {
  return state.chats.find((chat) => chat.id === state.currentChatId) || null;
}

function createChat() {
  const chat = { id: crypto.randomUUID(), title: 'New chat', updatedAt: Date.now(), mode: state.mode, messages: [] };
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
  saveChat(chat).catch((error) => {
    console.error('Could not save new chat:', error);
    showToast('This chat could not be saved on this device.');
  });
  renderAll();
  input.focus();
  closeSidebar();
}

async function hydrateChats(savedChats) {
  return Promise.all(savedChats.map(async (chat) => {
    const messages = await Promise.all(chat.messages.map(async (message) => {
      if (message.imageId) {
        const stored = await getImage(message.imageId);
        if (stored) return { ...message, imageUrl: URL.createObjectURL(stored.blob) };
      }
      if (!message.imagePath || state.session?.user?.id !== chat.syncUserId) {
        return { ...message, imageMissing: Boolean(message.imageId || message.imageMissing) };
      }
      try {
        const { data, error } = await state.supabase.storage.from(IMAGE_BUCKET).download(message.imagePath);
        if (error || !data) throw new Error(error?.message || 'Image download returned no data.');
        const imageId = message.imageId || crypto.randomUUID();
        await dbRequest(IMAGE_STORE, 'readwrite', (store) => store.put({ id: imageId, blob: data }));
        return {
          ...message,
          imageId,
          imageMissing: false,
          imageUrl: URL.createObjectURL(data)
        };
      } catch (error) {
        console.error('Could not download synced photo:', error);
        showToast('Some synced photos could not be loaded. Check your connection and try again.');
        return { ...message, imageMissing: true };
      }
    }));
    return { ...chat, messages };
  }));
}

async function loadChatsForUser(userId) {
  const savedChats = (await getAllChats())
    .filter((chat) => chat.syncUserId === userId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const hydratedChats = await hydrateChats(savedChats);
  releaseImageUrls(state.chats);
  state.chats = hydratedChats;
  for (const chat of state.chats) {
    await dbRequest(CHAT_STORE, 'readwrite', (store) => store.put(localChatRecord(chat)));
  }
}

function renderAll() {
  renderChatList();
  renderMessages();
}

function renderAttachmentPreview() {
  const preview = $('#attachmentPreview');
  preview.replaceChildren();
  if (!state.pendingImage) {
    preview.hidden = true;
    return;
  }
  const image = document.createElement('img');
  image.src = state.pendingImage.url;
  image.alt = 'Photo ready to attach';
  const remove = document.createElement('button');
  remove.className = 'remove-attachment';
  remove.type = 'button';
  remove.textContent = 'Remove photo';
  remove.addEventListener('click', () => {
    URL.revokeObjectURL(state.pendingImage.url);
    state.pendingImage = null;
    renderAttachmentPreview();
    updateSendButton();
  });
  preview.append(image, remove);
  preview.hidden = false;
}

async function compressPhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a JPEG, PNG, or WebP photo.');
  }
  if (file.size > 12_000_000) {
    throw new Error('Choose a photo smaller than 12 MB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare the photo.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.68, 0.54]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= 1_450_000) return blob;
    }
    throw new Error('This photo could not be compressed to a safe upload size.');
  } finally {
    bitmap.close();
  }
}

async function choosePhoto(file) {
  if (!file) return;
  try {
    const blob = await compressPhoto(file);
    if (state.pendingImage) URL.revokeObjectURL(state.pendingImage.url);
    state.pendingImage = { blob, url: URL.createObjectURL(blob) };
    renderAttachmentPreview();
    updateSendButton();
  } catch (error) {
    console.error('Could not prepare photo:', error);
    showToast(error.message || 'This photo could not be attached.');
  } finally {
    $('#photoInput').value = '';
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('The image response could not be read.');
  const bytes = atob(match[2]);
  const data = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) data[index] = bytes.charCodeAt(index);
  return new Blob([data], { type: match[1] });
}

function renderChatList() {
  const query = $('#chatSearch').value.trim().toLowerCase();
  const visible = state.chats.filter((chat) => chat.title.toLowerCase().includes(query));
  const list = $('#chatList');
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-history';
    empty.textContent = query ? 'No chats match that search.' : 'Your conversations will show up here once you start one.';
    list.append(empty);
    return;
  }
  visible.forEach((chat) => {
    const item = document.createElement('div');
    item.className = `chat-item${chat.id === state.currentChatId ? ' active' : ''}`;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', chat.title);
    const icon = document.createElement('span');
    icon.className = 'chat-item-icon';
    icon.textContent = '◌';
    const title = document.createElement('span');
    title.className = 'chat-item-title';
    title.textContent = chat.title;
    const remove = document.createElement('button');
    remove.className = 'delete-chat';
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete ${chat.title}`);
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteChat(chat.id);
    });
    item.append(icon, title, remove);
    item.addEventListener('click', () => selectChat(chat.id));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectChat(chat.id);
      }
    });
    list.append(item);
  });
}

function renderMessages() {
  const chat = currentChat();
  const hasMessages = chat && chat.messages.length > 0;
  welcome.hidden = Boolean(hasMessages);
  messageList.replaceChildren();
  if (!hasMessages) return;

  chat.messages.forEach((message) => {
    const row = document.createElement('article');
    row.className = `message ${message.role === 'user' ? 'user' : ''}${message.error ? ' error' : ''}`;
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.role === 'user' ? (state.settings.name?.[0]?.toUpperCase() || 'U') : 'u.';
    const body = document.createElement('div');
    body.className = 'message-body';
    if (message.role !== 'user') {
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = message.error ? '_UHH · ISSUE' : '_UHH';
      body.append(label);
    }
    if (message.pending) {
      const dots = document.createElement('span');
      dots.className = 'typing-dots';
      dots.setAttribute('aria-label', 'Thinking');
      dots.innerHTML = '<i></i><i></i><i></i>';
      body.append(dots);
    } else if (message.content) {
      const content = document.createElement('div');
      content.className = 'message-content';
      content.textContent = message.content;
      body.append(content);
    }
    if (message.imageUrl) {
      const image = document.createElement('img');
      image.className = 'message-image';
      image.src = message.imageUrl;
      image.alt = message.role === 'user'
        ? 'Attached photo'
        : `Generated image: ${message.content || 'image'}`;
      const download = document.createElement('a');
      download.className = 'download-image';
      download.href = message.imageUrl;
      download.download = message.role === 'user' ? 'uhh-attached-photo.jpg' : 'uhh-generated-image.jpg';
      download.textContent = '↓  Save image';
      body.append(image, download);
    } else if (message.imageMissing) {
      const note = document.createElement('div');
      note.className = 'message-content';
      note.textContent = 'This image could not be loaded. Check your connection and try again.';
      body.append(note);
    }
    row.append(avatar, body);
    messageList.append(row);
  });
}

function selectChat(id) {
  const chat = state.chats.find((item) => item.id === id);
  if (!chat) return;
  state.currentChatId = id;
  setMode(chat.mode || 'casual');
  renderAll();
  closeSidebar();
  scrollToBottom();
}

async function deleteChat(id) {
  const chat = state.chats.find((item) => item.id === id);
  if (!chat) return;
  try {
    if (state.session) {
      await removeCloudImages(chat, state.session.user.id);
      await upsertCloudChat({ ...chat, updatedAt: Date.now() }, state.session.user.id, true);
    }
    await removeChatRecord(id);
    chat.messages.forEach((message) => {
      if (message.imageUrl) URL.revokeObjectURL(message.imageUrl);
    });
    state.chats = state.chats.filter((item) => item.id !== id);
    if (state.currentChatId === id) state.currentChatId = null;
    renderAll();
  } catch (error) {
    console.error('Could not delete chat:', error);
    showToast('Could not delete that chat. Please try again.');
  }
}

function makeSystemInstruction() {
  const name = state.settings.name ? ` The user's preferred name is ${state.settings.name}.` : '';
  const preferences = state.settings.instructions ? `\nThe user shared these response preferences: ${state.settings.instructions}` : '';
  return `You are _UHH, a friendly, capable AI assistant created by Plunger Studios. ${MODE_PROMPTS[state.mode]}${name}${preferences}
Be honest about uncertainty, avoid inventing facts, and ask a brief clarifying question when needed. Follow the AI provider's safety policies. Do not help with harmful requests; when a request is unsafe, briefly explain and offer a safer alternative. Never claim to have generated, seen, or done something you have not.`;
}

async function postJson(path, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.session?.access_token) {
    headers.Authorization = `Bearer ${state.session.access_token}`;
  }
  const response = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (result.code === 'all_providers_unavailable') showOutage();
  if (!response.ok) throw new Error(result.error || `The request failed (${response.status}).`);
  return result;
}

function ensureCurrentChat(text) {
  let chat = currentChat();
  if (!chat) {
    chat = { id: crypto.randomUUID(), title: text.slice(0, 42).trim() || 'New chat', updatedAt: Date.now(), mode: state.mode, messages: [] };
    state.chats.unshift(chat);
    state.currentChatId = chat.id;
  } else if (chat.messages.length === 0) {
    chat.title = text.slice(0, 42).trim() || 'New chat';
  }
  return chat;
}

async function submitMessage(text) {
  const attachment = state.pendingImage;
  if (state.busy || (!text.trim() && !attachment)) return;
  const prompt = text.trim() || 'What is in this photo?';
  const imageId = attachment ? crypto.randomUUID() : null;
  if (attachment) {
    try {
      await dbRequest(IMAGE_STORE, 'readwrite', (store) => store.put({ id: imageId, blob: attachment.blob }));
    } catch (error) {
      console.error('Could not save attached photo:', error);
      showToast('This photo could not be saved in this browser.');
      return;
    }
  }
  const chat = ensureCurrentChat(prompt);
  const userMessage = { id: crypto.randomUUID(), role: 'user', content: prompt };
  if (attachment) {
    userMessage.imageId = imageId;
    userMessage.imageUrl = attachment.url;
    state.pendingImage = null;
    renderAttachmentPreview();
  }
  const pendingMessage = { id: crypto.randomUUID(), role: 'model', content: '', pending: true };
  chat.messages.push(userMessage, pendingMessage);
  chat.mode = state.mode;
  chat.updatedAt = Date.now();
  state.busy = true;
  input.value = '';
  resizeInput();
  updateSendButton();
  renderAll();
  scrollToBottom();

  try {
    const recentMessages = chat.messages
      .filter((message) => !message.pending)
      .slice(-20);
    const latestPhoto = [...recentMessages].reverse().find((message) => message.role === 'user' && message.imageId);
    const messages = await Promise.all(recentMessages.map(async (message) => {
      const requestMessage = {
        role: message.role === 'model' ? 'assistant' : 'user',
        content: message.content
      };
      if (message.id === latestPhoto?.id) {
        const stored = await getImage(message.imageId);
        if (!stored?.blob) throw new Error('The attached photo is no longer available on this device.');
        requestMessage.image = await blobToDataUrl(stored.blob);
      }
      return requestMessage;
    }));
    const result = await postJson('/api/chat', {
      messages,
      mode: state.mode,
      systemInstruction: makeSystemInstruction()
    });
    pendingMessage.content = result.text;
  } catch (error) {
    pendingMessage.pending = false;
    pendingMessage.error = true;
    pendingMessage.content = error.message || 'Something went wrong. Please try again.';
  }

  pendingMessage.pending = false;
  chat.updatedAt = Date.now();
  state.busy = false;
  updateSendButton();
  try {
    await saveChat(chat);
  } catch (error) {
    console.error('Could not save conversation:', error);
    showToast('The reply appeared, but this conversation could not be saved.');
  }
  renderAll();
  scrollToBottom();
}

async function generateImageFromPrompt() {
  const prompt = input.value.trim();
  if (state.busy || !prompt) return;
  if (prompt.length > 2_048) {
    showToast('Keep image prompts under 2,048 characters.');
    return;
  }
  const chat = ensureCurrentChat(`Create an image: ${prompt}`);
  const userMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: `Create an image: ${prompt}`
  };
  const pendingMessage = { id: crypto.randomUUID(), role: 'model', content: '', pending: true };
  chat.messages.push(userMessage, pendingMessage);
  chat.mode = state.mode;
  chat.updatedAt = Date.now();
  state.busy = true;
  input.value = '';
  resizeInput();
  updateSendButton();
  renderAll();
  scrollToBottom();

  let generatedImage = null;
  try {
    const result = await postJson('/api/images/generate', { prompt });
    generatedImage = dataUrlToBlob(result.image);
  } catch (error) {
    pendingMessage.error = true;
    pendingMessage.content = error.message || 'The image could not be created.';
  }
  if (generatedImage) {
    pendingMessage.content = prompt;
    pendingMessage.imageUrl = URL.createObjectURL(generatedImage);
    try {
      const imageId = crypto.randomUUID();
      await dbRequest(IMAGE_STORE, 'readwrite', (store) => store.put({ id: imageId, blob: generatedImage }));
      pendingMessage.imageId = imageId;
    } catch (error) {
      console.error('Could not save generated image locally:', error);
      showToast('The image was created but could not be saved in this browser.');
    }
  }
  pendingMessage.pending = false;
  chat.updatedAt = Date.now();
  state.busy = false;
  updateSendButton();
  try {
    await saveChat(chat);
  } catch (error) {
    console.error('Could not save generated image:', error);
    showToast('The image appeared, but this conversation could not be saved.');
  }
  renderAll();
  scrollToBottom();
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

function updateSendButton() {
  sendButton.disabled = state.busy || (!input.value.trim() && !state.pendingImage);
  sendButton.setAttribute('aria-label', 'Send message');
  $('#generateImageButton').disabled = state.busy || !input.value.trim();
  $('#attachPhotoButton').disabled = state.busy;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const conversation = $('#conversation');
    conversation.scrollTop = conversation.scrollHeight;
  });
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3800);
}

async function checkApiStatus() {
  const status = $('#connectionStatus');
  try {
    const response = await fetch('/api/status');
    const result = await response.json();
    if (result.available) {
      status.className = 'connection-status ready';
      status.lastElementChild.textContent = 'AI available';
      $('#outageGate').hidden = true;
      state.outageVisible = false;
    } else if (result.reason === 'backend_not_configured') {
      status.className = 'connection-status offline';
      status.lastElementChild.textContent = 'Backend not connected';
    } else if (!result.configured) {
      status.className = 'connection-status offline';
      status.lastElementChild.textContent = 'AI service not configured';
    } else {
      status.className = 'connection-status offline';
      status.lastElementChild.textContent = result.reason === 'backend_unreachable'
        ? 'AI service starting'
        : 'AI temporarily unavailable';
    }
  } catch (error) {
    console.error('Could not check AI provider status:', error);
    status.className = 'connection-status offline';
    status.lastElementChild.textContent = 'AI server unavailable';
  }
}

function showOutage() {
  state.outageVisible = true;
  $('#outageGate').hidden = false;
  checkApiStatus();
}

function openSettings() {
  updateProfile();
  $('#settingsPanel').classList.add('open');
  $('#settingsPanel').setAttribute('aria-hidden', 'false');
  $('#backdrop').classList.add('visible');
}

function closeSettings() {
  $('#settingsPanel').classList.remove('open');
  $('#settingsPanel').setAttribute('aria-hidden', 'true');
  $('#backdrop').classList.remove('visible');
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#backdrop').classList.remove('visible');
}

function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#backdrop').classList.add('visible');
}

function bindEvents() {
  $('#newChatButton').addEventListener('click', createChat);
  $('#settingsButton').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#backdrop').addEventListener('click', () => { closeSettings(); closeSidebar(); });
  $('#saveSettings').addEventListener('click', savePreferences);
  $('#signOutButton').addEventListener('click', signOut);
  $('#signInForm').addEventListener('submit', continueWithEmail);
  window.addEventListener('focus', refreshCloudChats);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshCloudChats();
  });
  $('#emailInput').addEventListener('input', updateGate);
  $('#termsCheckbox').addEventListener('change', updateGate);
  $('#chatSearch').addEventListener('input', renderChatList);
  $('#openSidebar').addEventListener('click', openSidebar);
  $('#closeSidebar').addEventListener('click', closeSidebar);
  $('#attachPhotoButton').addEventListener('click', () => $('#photoInput').click());
  $('#photoInput').addEventListener('change', (event) => choosePhoto(event.target.files[0]));
  $('#generateImageButton').addEventListener('click', generateImageFromPrompt);
  document.querySelectorAll('.mode-button').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  document.querySelectorAll('.suggestion').forEach((button) => {
    button.addEventListener('click', () => {
      input.value = button.dataset.prompt || '';
      resizeInput();
      updateSendButton();
      input.focus();
    });
  });
  input.addEventListener('input', () => { resizeInput(); updateSendButton(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composerForm').requestSubmit();
    }
  });
  $('#composerForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value;
    if (text.trim()) submitMessage(text);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      createChat();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      $('#chatSearch').focus();
    } else if (event.key === 'Escape') {
      closeSettings();
      closeSidebar();
    }
  });
}

async function init() {
  bindEvents();
  const savedMode = localStorage.getItem('uhh-mode');
  setMode(Object.hasOwn(MODE_PROMPTS, savedMode) ? savedMode : 'casual');
  updateProfile();
  updateGate();
  renderAll();
  checkApiStatus();
  try {
    state.db = await openDatabase();
  } catch (error) {
    console.error('Could not initialize chat storage:', error);
    showToast('Local chat storage is unavailable. Chats may not be saved in this browser.');
  }
  try {
    await initializeSupabase();
  } catch (error) {
    console.error('Could not initialize secure sign-in:', error);
    state.authError = error.message || 'Secure sign-in could not be initialized.';
    updateGate();
  }
  window.setInterval(() => {
    if (state.outageVisible) checkApiStatus();
  }, 20_000);
}

init();
