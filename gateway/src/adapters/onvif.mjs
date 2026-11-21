import dgram from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import { log } from '../log.mjs';

const DISCOVERY_ADDRESS = '239.255.255.250';
const DISCOVERY_PORT = 3702;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function usernameToken(username, password) {
  const nonce = randomBytes(16);
  const created = new Date().toISOString();
  const digest = createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(String(password), 'utf8')]))
    .digest('base64');
  return `<s:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${escapeXml(username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
}

/**
 * WS-Discovery probe on the local network. Returns ONVIF-capable endpoints
 * advertising themselves as NetworkVideoTransmitters (most DVRs/NVRs).
 */
export function wsDiscover({ timeoutMs = 3500 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map();
    let closed = false;
    let messageId = null;

    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* noop */
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', (err) => {
      log.warn('onvif.discovery_socket_error', { error: err.message });
      finish();
    });
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/ProbeMatch/i.test(text)) return;
      const xaddrMatch = /<[^>]*:XAddrs>([\s\S]*?)<\/[^>]*:XAddrs>/i.exec(text);
      if (!xaddrMatch) return;
      const scopesMatch = /<[^>]*:Scopes>([\s\S]*?)<\/[^>]*:Scopes>/i.exec(text);
      const typesMatch = /<[^>]*:Types>([\s\S]*?)<\/[^>]*:Types>/i.exec(text);
      const scopes = scopesMatch ? decodeXml(scopesMatch[1]).split(/\s+/) : [];
      for (const xaddr of decodeXml(xaddrMatch[1]).split(/\s+/).filter(Boolean)) {
        if (found.has(xaddr)) continue;
        found.set(xaddr, {
          xaddr,
          ip: rinfo.address,
          scopes: scopes.slice(0, 20),
          name: scopes.find((s) => /\/name\//i.test(s))?.split('/name/')[1] ?? null,
          hardware: scopes.find((s) => /\/hardware\//i.test(s))?.split('/hardware/')[1] ?? null,
          types: typesMatch ? decodeXml(typesMatch[1]).split(/\s+/).slice(0, 5) : [],
        });
      }
    });
    socket.bind(() => {
      try {
        socket.setMulticastTTL(2);
        messageId = `uuid:${randomBytes(16).toString('hex')}`;
        const probe = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
  xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>${messageId}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>
  </e:Body>
</e:Envelope>`;
        socket.send(probe, DISCOVERY_PORT, DISCOVERY_ADDRESS, (err) => {
          if (err) {
            log.warn('onvif.discovery_send_failed', { error: err.message });
            finish();
          }
        });
      } catch (err) {
        log.warn('onvif.discovery_failed', { error: err.message });
        finish();
      }
    });
  });
}

async function soapPost(url, body, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', Accept: 'application/soap+xml' },
      body,
      signal: controller.signal,
    });
    let text = await response.text();
    if (!response.ok && response.status === 415) {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
        body,
        signal: controller.signal,
      });
      text = await response.text();
    }
    if (!response.ok) {
      const fault = /<(?:[A-Za-z0-9]+:)?(?:Reason|Text)[^>]*>([\s\S]*?)<\//.exec(text);
      throw new Error(`ONVIF HTTP ${response.status}${fault ? `: ${decodeXml(fault[1]).slice(0, 200)}` : ''}`);
    }
    if (/<[^>]*Fault/i.test(text)) {
      const reason = /<(?:[A-Za-z0-9]+:)?(?:Reason|Text)[^>]*>([\s\S]*?)<\//.exec(text);
      throw new Error(`ONVIF fault${reason ? `: ${decodeXml(reason[1]).slice(0, 200)}` : ''}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function envelope(authHeader, bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
  xmlns:tt="http://www.onvif.org/ver10/schema"
  xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
  ${authHeader}
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
}

function extract(text, tag) {
  const match = new RegExp(`<[^>]*:${tag}>([\\s\\S]*?)</[^>]*:${tag}>`, 'i').exec(text);
  return match ? decodeXml(match[1]).trim() : null;
}

function deviceServiceUrl(xaddr) {
  try {
    const u = new URL(xaddr);
    return `${u.protocol}//${u.host}/onvif/device_service`;
  } catch {
    return xaddr;
  }
}

/**
 * Reads device information, media profiles and video sources.
 * Returns channel-like profiles so the setup wizard can count cameras without guessing.
 */
export async function onvifProbe({ xaddr, username, password, timeoutMs = 10_000 }) {
  const serviceUrl = deviceServiceUrl(xaddr);
  const auth = username ? usernameToken(username, password ?? '') : '';
  const headers = { timeoutMs };

  const infoXml = await soapPost(serviceUrl, envelope(auth, '<tds:GetDeviceInformation/>'), headers);
  const device = {
    manufacturer: extract(infoXml, 'Manufacturer'),
    model: extract(infoXml, 'Model'),
    firmware: extract(infoXml, 'FirmwareVersion'),
    serial: extract(infoXml, 'SerialNumber'),
    hardwareId: extract(infoXml, 'HardwareId'),
  };

  let mediaAddress = null;
  try {
    const capsXml = await soapPost(serviceUrl, envelope(auth, '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>'), headers);
    const mediaBlock = /<(?:[A-Za-z0-9]+:)?Media>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?Media>/i.exec(capsXml);
    if (mediaBlock) {
      const addr = /<(?:[A-Za-z0-9]+:)?XAddr>([\s\S]*?)<\//i.exec(mediaBlock[1]);
      if (addr) mediaAddress = decodeXml(addr[1]).trim();
    }
  } catch (err) {
    log.warn('onvif.capabilities_failed', { error: err.message });
  }
  if (!mediaAddress) {
    const u = new URL(serviceUrl);
    mediaAddress = `${u.protocol}//${u.host}/onvif/media_service`;
  }

  let profiles = [];
  try {
    const profilesXml = await soapPost(mediaAddress, envelope(auth, '<trt:GetProfiles/>'), headers);
    const blocks = profilesXml.split(/<(?:[A-Za-z0-9]+:)?Profiles\s/i).slice(1);
    profiles = blocks.map((block, index) => {
      const token = /\stoken="([^"]+)"/i.exec(block)?.[1] ?? `profile-${index + 1}`;
      const name = /<(?:[A-Za-z0-9]+:)?Name>([\s\S]*?)<\//i.exec(block)?.[1] ?? `Profile ${index + 1}`;
      const sourceToken = /<(?:[A-Za-z0-9]+:)?SourceToken>([\s\S]*?)<\//i.exec(block)?.[1] ?? null;
      return { token, name: decodeXml(name).trim(), sourceToken };
    });
  } catch (err) {
    log.warn('onvif.profiles_failed', { error: err.message });
  }

  let videoSources = 0;
  try {
    const sourcesXml = await soapPost(mediaAddress, envelope(auth, '<trt:GetVideoSources/>'), headers);
    videoSources = (sourcesXml.match(/<(?:[A-Za-z0-9]+:)?VideoSources\s/gi) ?? []).length;
  } catch {
    videoSources = 0;
  }

  return {
    ok: true,
    serviceUrl,
    mediaAddress,
    device,
    profiles,
    channels: Math.max(profiles.length, videoSources),
  };
}
