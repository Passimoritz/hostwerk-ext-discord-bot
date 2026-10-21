'use strict';
/*
 * Texts in the language of the person in Discord (not of Hostwerk): English source text, German from locales/de.json –
 * the same file Hostwerk uses for the page. host.t() would always answer in Hostwerk's own language.
 */
const fs = require('fs');
const path = require('path');

const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : String(s));

function translator(file = path.join(__dirname, '..', 'locales', 'de.json')) {
  let de = {};
  try { de = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* English only */ }
  return (lang, text, vars) => fill(lang === 'de' && typeof de[text] === 'string' && de[text] ? de[text] : text, vars);
}

module.exports = { translator, fill };
