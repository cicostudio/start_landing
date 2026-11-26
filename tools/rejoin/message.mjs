// 文案在 worker/rejoin-message.js（後台網頁發送與本機腳本共用）
import { buildMessage as build, landingUrl as land, CAMPAIGN } from '../../worker/rejoin-message.js';
export { CAMPAIGN };
export const SITE = process.env.SITE || 'https://cico.tw';
export const buildMessage = (token) => build(token, SITE);
export const landingUrl = (token) => land(token, SITE);
