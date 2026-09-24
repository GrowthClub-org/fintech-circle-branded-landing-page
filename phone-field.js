/* Shared phone field: searchable country dialling code + E.164 normalisation.
   Used by index.html, application.html and application-future.html.
   Pairs with phone-field.css - keep the two together.

   Expects this markup (ids matter):
     #countryCombo > #countryTrigger > #countryTriggerText
                   > #countryPanel > #countrySearch + #countryList
     #phone, #phoneHint, #countryCode (hidden)

   Usage:
     const phone = PhoneField.init({ required: true });
     const result = phone.showFeedback();   // {ok, value, message}
*/
window.PhoneField = (function () {
  'use strict';

  /* ---------- Country dialling codes ----------
     [iso, name, dial, example national number, min digits, max digits]
     Lengths are national significant digits, kept deliberately permissive
     where a country's numbering plan varies. */
  const COUNTRIES = [
    ['GB', 'United Kingdom', '+44', '7400 123456', 9, 10],
    ['US', 'United States', '+1', '201 555 0123', 10, 10],
    ['CA', 'Canada', '+1', '506 234 5678', 10, 10],
    ['IE', 'Ireland', '+353', '85 012 3456', 7, 9],
    ['DE', 'Germany', '+49', '1512 3456789', 6, 11],
    ['FR', 'France', '+33', '6 12 34 56 78', 9, 9],
    ['ES', 'Spain', '+34', '612 34 56 78', 9, 9],
    ['IT', 'Italy', '+39', '312 345 6789', 6, 11],
    ['NL', 'Netherlands', '+31', '6 12345678', 9, 9],
    ['BE', 'Belgium', '+32', '470 12 34 56', 8, 9],
    ['LU', 'Luxembourg', '+352', '628 123 456', 4, 11],
    ['CH', 'Switzerland', '+41', '78 123 45 67', 9, 9],
    ['AT', 'Austria', '+43', '664 123456', 4, 13],
    ['SE', 'Sweden', '+46', '70 123 45 67', 7, 13],
    ['NO', 'Norway', '+47', '406 12 345', 8, 8],
    ['DK', 'Denmark', '+45', '32 12 34 56', 8, 8],
    ['FI', 'Finland', '+358', '41 2345678', 5, 12],
    ['IS', 'Iceland', '+354', '611 1234', 7, 9],
    ['PL', 'Poland', '+48', '512 345 678', 9, 9],
    ['CZ', 'Czech Republic', '+420', '601 123 456', 9, 9],
    ['PT', 'Portugal', '+351', '912 345 678', 9, 9],
    ['GR', 'Greece', '+30', '691 234 5678', 10, 10],
    ['RO', 'Romania', '+40', '712 034 567', 9, 9],
    ['HU', 'Hungary', '+36', '20 123 4567', 8, 9],
    ['EE', 'Estonia', '+372', '5123 4567', 7, 8],
    ['LV', 'Latvia', '+371', '21 234 567', 8, 8],
    ['LT', 'Lithuania', '+370', '612 34567', 8, 8],
    ['MT', 'Malta', '+356', '9696 1234', 8, 8],
    ['CY', 'Cyprus', '+357', '96 123456', 8, 8],
    ['AE', 'United Arab Emirates', '+971', '50 123 4567', 8, 9],
    ['SA', 'Saudi Arabia', '+966', '51 234 5678', 9, 9],
    ['QA', 'Qatar', '+974', '3312 3456', 8, 8],
    ['BH', 'Bahrain', '+973', '3600 1234', 8, 8],
    ['KW', 'Kuwait', '+965', '500 12345', 8, 8],
    ['OM', 'Oman', '+968', '9212 3456', 8, 8],
    ['IL', 'Israel', '+972', '50 123 4567', 8, 9],
    ['TR', 'Turkey', '+90', '501 234 56 78', 10, 10],
    ['ZA', 'South Africa', '+27', '71 123 4567', 9, 9],
    ['NG', 'Nigeria', '+234', '802 123 4567', 7, 10],
    ['KE', 'Kenya', '+254', '712 123456', 9, 9],
    ['GH', 'Ghana', '+233', '24 123 4567', 9, 9],
    ['EG', 'Egypt', '+20', '100 123 4567', 9, 10],
    ['MA', 'Morocco', '+212', '650 123456', 9, 9],
    ['IN', 'India', '+91', '81234 56789', 10, 10],
    ['PK', 'Pakistan', '+92', '301 2345678', 10, 10],
    ['BD', 'Bangladesh', '+880', '1812 345678', 10, 10],
    ['LK', 'Sri Lanka', '+94', '71 234 5678', 9, 9],
    ['CN', 'China', '+86', '131 2345 6789', 5, 12],
    ['HK', 'Hong Kong', '+852', '5123 4567', 8, 8],
    ['TW', 'Taiwan', '+886', '912 345 678', 9, 9],
    ['JP', 'Japan', '+81', '90 1234 5678', 9, 10],
    ['KR', 'South Korea', '+82', '10 1234 5678', 9, 10],
    ['SG', 'Singapore', '+65', '8123 4567', 8, 8],
    ['MY', 'Malaysia', '+60', '12 345 6789', 9, 10],
    ['ID', 'Indonesia', '+62', '812 345 678', 9, 11],
    ['TH', 'Thailand', '+66', '81 234 5678', 9, 9],
    ['VN', 'Vietnam', '+84', '912 345 678', 9, 9],
    ['PH', 'Philippines', '+63', '905 123 4567', 10, 10],
    ['AU', 'Australia', '+61', '412 345 678', 9, 9],
    ['NZ', 'New Zealand', '+64', '21 123 4567', 8, 10],
    ['BR', 'Brazil', '+55', '11 96123 4567', 10, 11],
    ['MX', 'Mexico', '+52', '222 123 4567', 10, 10],
    ['AR', 'Argentina', '+54', '11 2345 6789', 10, 10],
    ['CL', 'Chile', '+56', '9 6123 4567', 9, 9],
    ['CO', 'Colombia', '+57', '321 1234567', 10, 10],
    ['PE', 'Peru', '+51', '912 345 678', 9, 9],
    ['RU', 'Russia', '+7', '912 345 6789', 10, 10],
    ['UA', 'Ukraine', '+380', '50 123 4567', 9, 9]
  ].map(function (c) {
    return { iso: c[0], name: c[1], dial: c[2], example: c[3], min: c[4], max: c[5] };
  });

  function digitsOf(v) {
    return String(v).replace(/[^0-9]/g, '');
  }

  /* ---------- Searchable country selector ---------- */
  let combo, trigger, triggerText, panel, search, list, phoneField, phoneHint, countryCodeField;
  let isRequired = false;

  let selectedCountry = COUNTRIES[0];
  let shown = COUNTRIES.slice();
  let activeIndex = 0;

  function renderList(filter) {
    const q = (filter || '').trim().toLowerCase();
    const qDigits = digitsOf(q);

    shown = COUNTRIES.filter(function (c) {
      if (!q) return true;
      if (c.name.toLowerCase().indexOf(q) !== -1) return true;
      if (c.iso.toLowerCase() === q) return true;
      return qDigits !== '' && digitsOf(c.dial).indexOf(qDigits) === 0;
    });

    list.innerHTML = '';

    if (shown.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'country-empty';
      empty.textContent = 'No matching country';
      list.appendChild(empty);
      activeIndex = -1;
      return;
    }

    shown.forEach(function (c) {
      const li = document.createElement('li');
      li.id = 'country-opt-' + c.iso + '-' + digitsOf(c.dial);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', c === selectedCountry ? 'true' : 'false');

      const dial = document.createElement('span');
      dial.className = 'dial';
      dial.textContent = c.dial;
      const name = document.createElement('span');
      name.textContent = c.name;
      li.appendChild(dial);
      li.appendChild(name);

      li.addEventListener('mousedown', function (e) {
        e.preventDefault();
        selectCountry(c);
        closePanel();
        trigger.focus();
      });
      list.appendChild(li);
    });

    activeIndex = shown.indexOf(selectedCountry);
    if (activeIndex < 0) activeIndex = 0;
    highlight();
  }

  function highlight() {
    for (let i = 0; i < list.children.length; i++) {
      list.children[i].classList.toggle('is-active', i === activeIndex);
    }
    const active = list.children[activeIndex];
    if (active) {
      if (active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
      search.setAttribute('aria-activedescendant', active.id);
    }
  }

  function selectCountry(c) {
    selectedCountry = c;
    countryCodeField.value = c.dial;
    triggerText.textContent = c.dial + ' ' + c.name;
    trigger.setAttribute('aria-label', 'Country dialling code, ' + c.name + ' ' + c.dial + ' selected');
    phoneField.placeholder = c.example;
    if (phoneField.value.trim()) showPhoneFeedback();
    else clearPhoneFeedback();
  }

  function openPanel() {
    combo.classList.add('is-open');
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    search.value = '';
    renderList('');
    search.focus();
  }

  function closePanel() {
    combo.classList.remove('is-open');
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function wireEvents() {
    trigger.addEventListener('click', function () {
    if (panel.hidden) openPanel();
    else closePanel();
  });

  search.addEventListener('input', function () {
    renderList(search.value);
  });

  search.addEventListener('keydown', function (e) {
    /* Stop these reaching the form's Enter-to-register listener below -
       preventDefault stops the browser acting, not the event bubbling. */
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].indexOf(e.key) !== -1) {
      e.stopPropagation();
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (shown.length) {
        activeIndex = (activeIndex + 1) % shown.length;
        highlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) {
        activeIndex = (activeIndex - 1 + shown.length) % shown.length;
        highlight();
      }
    } else if (e.key === 'Enter') {
      // Enter picks the highlighted country; it must never register
      e.preventDefault();
      if (shown.length && activeIndex >= 0) {
        selectCountry(shown[activeIndex]);
        closePanel();
        trigger.focus();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
      trigger.focus();
    }
  });

    document.addEventListener('click', function (e) {
      if (!panel.hidden && !combo.contains(e.target)) closePanel();
    });

    phoneField.addEventListener('blur', showPhoneFeedback);
    phoneField.addEventListener('input', function () {
      if (!phoneField.value.trim()) clearPhoneFeedback();
      else if (phoneField.classList.contains('is-invalid')) showPhoneFeedback();
    });
  }

  /* ---------- Phone validation ----------
     Optional field: empty is always valid. When something is entered it is
     checked against the selected country's digit range and normalised to
     E.164 (e.g. +447400123456). */
  function resolvePhone() {
    const raw = phoneField.value.trim();
    if (!raw) return { ok: true, value: '' };

    let country = selectedCountry;
    let national;

    if (raw.charAt(0) === '+') {
      // Already international: identify the country from the code itself
      const all = digitsOf(raw);
      const matches = COUNTRIES.filter(function (c) {
        return all.indexOf(digitsOf(c.dial)) === 0;
      }).sort(function (a, b) {
        return digitsOf(b.dial).length - digitsOf(a.dial).length;
      });

      if (matches.length === 0) {
        if (all.length < 7 || all.length > 15) {
          return { ok: false, message: 'That does not look like a valid international number.' };
        }
        return { ok: true, value: '+' + all };
      }
      country = matches[0];
      national = all.slice(digitsOf(country.dial).length);
    } else {
      // National format: drop any trunk prefix (UK 07400 -> 7400)
      national = digitsOf(raw).replace(/^0+/, '');
    }

    if (!national) {
      return { ok: false, message: 'Enter a phone number, or leave the field blank.' };
    }

    if (national.length < country.min || national.length > country.max) {
      const expected = country.min === country.max
        ? country.min + ' digits'
        : country.min + ' to ' + country.max + ' digits';
      return {
        ok: false,
        message: country.name + ' numbers are ' + expected + ' after ' + country.dial +
          '. You entered ' + national.length + '.'
      };
    }

    return { ok: true, value: '+' + digitsOf(country.dial) + national };
  }

  function clearPhoneFeedback() {
    phoneHint.hidden = true;
    phoneHint.textContent = '';
    phoneHint.classList.remove('is-error');
    phoneField.classList.remove('is-invalid');
    phoneField.removeAttribute('aria-invalid');
  }

  function showPhoneFeedback() {
    if (!phoneField.value.trim()) {
      clearPhoneFeedback();
      return { ok: true, value: '' };
    }
    const result = resolvePhone();
    phoneHint.hidden = false;
    if (result.ok) {
      phoneHint.classList.remove('is-error');
      phoneHint.textContent = 'Will be saved as ' + result.value;
      phoneField.classList.remove('is-invalid');
      phoneField.removeAttribute('aria-invalid');
    } else {
      phoneHint.classList.add('is-error');
      phoneHint.textContent = result.message;
      phoneField.classList.add('is-invalid');
      phoneField.setAttribute('aria-invalid', 'true');
    }
    return result;
  }


  function init(options) {
    combo = document.getElementById('countryCombo');
    trigger = document.getElementById('countryTrigger');
    triggerText = document.getElementById('countryTriggerText');
    panel = document.getElementById('countryPanel');
    search = document.getElementById('countrySearch');
    list = document.getElementById('countryList');
    phoneField = document.getElementById('phone');
    phoneHint = document.getElementById('phoneHint');
    countryCodeField = document.getElementById('countryCode');

    if (!combo || !phoneField || !countryCodeField) return null;
    isRequired = !!(options && options.required);

    wireEvents();

    // Initialise trigger label, placeholder and hidden field
    selectCountry(selectedCountry);
    renderList('');

    return {
      resolve: resolvePhone,
      showFeedback: showPhoneFeedback,
      clear: clearPhoneFeedback,
      focus: function () { phoneField.focus(); },
      element: function () { return phoneField; }
    };
  }

  return { init: init };
})();
