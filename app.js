// app.js — logique de l'app BHB.
// Toutes les données sont persistées dans IndexedDB (voir idb.js),
// avec des noms de champs alignés sur bhb_schema.sql.

// ---------------- ÉTAT EN MÉMOIRE (miroir d'IndexedDB) ----------------
let produits = [];
let depenses = [];
let charges = [];
let commandesValidees = []; // lignes de vente, une par produit vendu
let bilansMensuels = [];
let ticket = {}; // { produitId: montant } — pas encore persistée (panier en cours)
let periodeActuelle = 'jour';
let depProduitsSelectionnes = [];

const headerTitles = {
  commande: ['Commande', 'Beignet · Bouillie · Haricot'],
  depenses: ['Dépenses', 'Tout ce qui a été acheté'],
  charges: ['Charges', 'Loyer, salaire, imprévu, épargne'],
  dashboard: ['Tableau de bord', 'Bénéfice calculé en temps réel'],
  bilans: ['Bilans mensuels', 'Clôtures figées, mois par mois'],
};

// ---------------- INITIALISATION ----------------
async function init() {
  produits = await dbGetAll('produits');
  if (produits.length === 0) {
    produits = [
      { id: nouvelId('p'), nom: 'Beignet', categorie: 'friture', prix: 100 },
      { id: nouvelId('p'), nom: 'Bouillie', categorie: 'bouillie', prix: 150 },
      { id: nouvelId('p'), nom: 'Haricot', categorie: 'plat', prix: 200 },
    ];
    await dbBulkPut('produits', produits);
  }

  depenses = await dbGetAll('depenses');
  charges = await dbGetAll('charges');
  commandesValidees = await dbGetAll('commandes');
  bilansMensuels = await dbGetAll('bilans_mensuels');

  renderProdGrid();
  renderTicket();
  verifierRattrapageCloture();
  registrerServiceWorker();
  surveillerConnexion();
}

// ---------------- NAVIGATION ----------------
function switchScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  document.querySelectorAll('nav.bottom button').forEach((b) => b.classList.remove('active'));
  document.querySelector('nav.bottom button[data-screen="' + name + '"]').classList.add('active');
  document.getElementById('header-title').textContent = headerTitles[name][0];
  document.getElementById('header-sub').textContent = headerTitles[name][1];
  if (name === 'depenses') renderDepensesScreen();
  if (name === 'charges') renderChargesList();
  if (name === 'dashboard') renderDashboard();
  if (name === 'bilans') renderBilansScreen();
}

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1600);
}

// ---------------- ÉCRAN COMMANDE ----------------
function renderProdGrid() {
  const grid = document.getElementById('prod-grid');
  grid.innerHTML = '';
  produits.forEach((p) => {
    const montant = ticket[p.id] || '';
    const qteApprox = montant ? (montant / p.prix).toFixed(1) : null;
    const card = document.createElement('div');
    card.className = 'prod-card';
    card.innerHTML = `
      <div class="name">${p.nom}</div>
      <div class="cat">${p.categorie}</div>
      <div class="price">${p.prix} FCFA / unité</div>
      <div class="montant-input">
        <input type="number" inputmode="numeric" placeholder="Montant FCFA" value="${montant}"
          onchange="setMontant('${p.id}', this.value)">
        <div class="qty-hint">${qteApprox !== null ? '≈ ' + qteApprox + ' unité(s)' : '&nbsp;'}</div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function setMontant(id, value) {
  const val = parseFloat(value);
  if (!val || val <= 0) delete ticket[id];
  else ticket[id] = val;
  renderProdGrid();
  renderTicket();
}

function renderTicket() {
  const linesEl = document.getElementById('ticket-lines');
  const ids = Object.keys(ticket);
  if (ids.length === 0) {
    linesEl.innerHTML = '<div class="empty">Aucun article sélectionné</div>';
    document.getElementById('ticket-total').textContent = '0 FCFA';
    document.getElementById('btn-valider').disabled = true;
    return;
  }
  let total = 0;
  linesEl.innerHTML = ids.map((id) => {
    const p = produits.find((x) => x.id === id);
    const montant = ticket[id];
    const qteApprox = (montant / p.prix).toFixed(1);
    total += montant;
    return `<div class="line"><span>${p.nom} (≈${qteApprox} u.)</span><span>${montant} FCFA</span></div>`;
  }).join('');
  document.getElementById('ticket-total').textContent = total + ' FCFA';
  document.getElementById('btn-valider').disabled = false;
}

async function validerCommande() {
  const now = new Date().toISOString();
  const nouvelles = Object.keys(ticket).map((id) => {
    const p = produits.find((x) => x.id === id);
    const montant = ticket[id];
    return {
      id: nouvelId('cmd'),
      produitId: id,
      montant,
      quantiteApprox: montant / p.prix,
      prixUnitaire: p.prix,
      date: now,
      periode_cloturee: 0,
    };
  });
  await dbBulkPut('commandes', nouvelles);
  commandesValidees.push(...nouvelles);
  ticket = {};
  renderProdGrid();
  renderTicket();
  showToast('Commande validée ✓');
}

async function ajouterProduit() {
  const nom = document.getElementById('new-prod-nom').value.trim();
  const cat = document.getElementById('new-prod-cat').value.trim() || 'divers';
  const prix = parseFloat(document.getElementById('new-prod-prix').value);
  if (!nom || !prix) { showToast('Nom et prix requis'); return; }
  const nouveauProduit = { id: nouvelId('p'), nom, categorie: cat, prix };
  await dbPut('produits', nouveauProduit);
  produits.push(nouveauProduit);
  document.getElementById('new-prod-nom').value = '';
  document.getElementById('new-prod-cat').value = '';
  document.getElementById('new-prod-prix').value = '';
  closeModal('modal-produit');
  renderProdGrid();
  showToast(nom + ' ajouté au menu');
}

// ---------------- ÉCRAN DÉPENSES ----------------
function renderDepensesScreen() {
  const chips = document.getElementById('dep-produits-chips');
  chips.innerHTML = produits.map((p) => `
    <div class="chip ${depProduitsSelectionnes.includes(p.id) ? 'selected' : ''}" onclick="toggleDepProduit('${p.id}')">${p.nom}</div>
  `).join('');
  renderDepensesList();
}

function toggleDepProduit(id) {
  const idx = depProduitsSelectionnes.indexOf(id);
  if (idx === -1) depProduitsSelectionnes.push(id);
  else depProduitsSelectionnes.splice(idx, 1);
  renderDepensesScreen();
}

async function ajouterDepense() {
  const libelle = document.getElementById('dep-libelle').value.trim();
  const montant = parseFloat(document.getElementById('dep-montant').value);
  if (!libelle || !montant || depProduitsSelectionnes.length === 0) {
    showToast('Libellé, montant et produit(s) requis');
    return;
  }
  const nouvelleDepense = {
    id: nouvelId('dep'),
    libelle,
    montant,
    produits: [...depProduitsSelectionnes],
    date: new Date().toISOString(),
    periode_cloturee: 0,
  };
  await dbPut('depenses', nouvelleDepense);
  depenses.push(nouvelleDepense);
  document.getElementById('dep-libelle').value = '';
  document.getElementById('dep-montant').value = '';
  depProduitsSelectionnes = [];
  renderDepensesScreen();
  showToast('Dépense enregistrée');
}

function renderDepensesList() {
  const list = document.getElementById('depenses-list');
  if (depenses.length === 0) { list.innerHTML = '<div class="ticket empty" style="border:none; background:none;">Aucune dépense enregistrée</div>'; return; }
  list.innerHTML = depenses.slice().reverse().map((d) => {
    const noms = d.produits.map((pid) => produits.find((p) => p.id === pid)?.nom || '?').join(', ');
    const lockCls = d.periode_cloturee ? 'locked' : '';
    const lockIcon = d.periode_cloturee ? '<span class="lock-icon">🔒</span>' : '';
    return `<div class="list-item ${lockCls}">
      <div><div class="li-name">${lockIcon}${d.libelle}</div><div class="li-meta">${noms}</div></div>
      <div class="li-amount chili">−${d.montant}</div>
    </div>`;
  }).join('');
}

// ---------------- ÉCRAN CHARGES ----------------
async function ajouterCharge() {
  const type = document.getElementById('charge-type').value;
  const montant = parseFloat(document.getElementById('charge-montant').value);
  if (!montant) { showToast('Montant requis'); return; }
  const nouvelleCharge = {
    id: nouvelId('chg'),
    type,
    montant,
    statut: 'du',
    date: new Date().toISOString(),
    periode_cloturee: 0,
  };
  await dbPut('charges', nouvelleCharge);
  charges.push(nouvelleCharge);
  document.getElementById('charge-montant').value = '';
  renderChargesList();
  showToast('Charge enregistrée');
}

async function toggleChargeStatut(id) {
  const c = charges.find((x) => x.id === id);
  if (c.periode_cloturee) return;
  c.statut = c.statut === 'du' ? 'paye' : 'du';
  await dbPut('charges', c);
  renderChargesList();
}

function renderChargesList() {
  const list = document.getElementById('charges-list');
  if (charges.length === 0) { list.innerHTML = '<div class="ticket empty" style="border:none; background:none;">Aucune charge enregistrée</div>'; return; }
  list.innerHTML = charges.slice().reverse().map((c) => {
    const lockCls = c.periode_cloturee ? 'locked' : '';
    const lockIcon = c.periode_cloturee ? '<span class="lock-icon">🔒</span>' : '';
    return `<div class="list-item ${lockCls}" onclick="toggleChargeStatut('${c.id}')" style="cursor:${c.periode_cloturee ? 'default' : 'pointer'};">
      <div><div class="li-name">${lockIcon}${c.type}</div><div class="li-meta"><span class="status-tag ${c.statut}">${c.statut === 'paye' ? 'Payé' : 'Dû'}</span></div></div>
      <div class="li-amount chili">${c.montant} FCFA</div>
    </div>`;
  }).join('');
}

// ---------------- TABLEAU DE BORD ----------------
function debutPeriode(periode) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (periode === 'jour') return d;
  if (periode === 'semaine') {
    const jourSemaine = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - jourSemaine);
    return d;
  }
  if (periode === 'mois') { d.setDate(1); return d; }
  return d;
}

function formatDateCourt(d) {
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function setPeriod(periode) {
  periodeActuelle = periode;
  document.querySelectorAll('.period-tab').forEach((b) => b.classList.remove('active'));
  document.querySelector('.period-tab[data-period="' + periode + '"]').classList.add('active');
  renderDashboard();
}

function renderDashboard() {
  const debut = debutPeriode(periodeActuelle);
  const labels = { jour: "Aujourd'hui", semaine: 'Depuis lundi ' + formatDateCourt(debut), mois: 'Depuis le ' + formatDateCourt(debut) };
  document.getElementById('period-range').textContent = labels[periodeActuelle];

  const commandesFiltrees = commandesValidees.filter((l) => new Date(l.date) >= debut);
  const depensesFiltrees = depenses.filter((d) => new Date(d.date) >= debut);
  const chargesFiltrees = charges.filter((c) => new Date(c.date) >= debut);

  const caParProduit = {};
  produits.forEach((p) => caParProduit[p.id] = 0);
  commandesFiltrees.forEach((l) => { caParProduit[l.produitId] = (caParProduit[l.produitId] || 0) + l.montant; });
  const ca = Object.values(caParProduit).reduce((a, b) => a + b, 0);

  const coutParProduit = {};
  produits.forEach((p) => coutParProduit[p.id] = 0);
  depensesFiltrees.forEach((d) => {
    const part = d.montant / d.produits.length;
    d.produits.forEach((pid) => { coutParProduit[pid] = (coutParProduit[pid] || 0) + part; });
  });
  const coutTotal = Object.values(coutParProduit).reduce((a, b) => a + b, 0);

  const margeBrute = ca - coutTotal;
  const chargesHorsEpargne = chargesFiltrees.filter((c) => c.type !== 'Épargne').reduce((a, c) => a + c.montant, 0);
  const epargne = chargesFiltrees.filter((c) => c.type === 'Épargne').reduce((a, c) => a + c.montant, 0);
  const beneficeNet = margeBrute - chargesHorsEpargne;

  document.getElementById('kpi-ca').textContent = ca + ' FCFA';
  document.getElementById('kpi-cout').textContent = '−' + coutTotal + ' FCFA';
  document.getElementById('kpi-marge').textContent = margeBrute + ' FCFA';
  document.getElementById('kpi-charges').textContent = '−' + chargesHorsEpargne + ' FCFA';
  document.getElementById('kpi-benefice').textContent = beneficeNet + ' FCFA';
  document.getElementById('epargne-note').textContent = 'Épargne à provisionner sur la période : ' + epargne + ' FCFA — non déduite du bénéfice.';

  const bars = document.getElementById('marge-bars');
  const maxCA = Math.max(1, ...Object.values(caParProduit));
  bars.innerHTML = produits.map((p) => {
    const margeP = caParProduit[p.id] - coutParProduit[p.id];
    const pct = Math.max(0, (caParProduit[p.id] / maxCA) * 100);
    return `<div class="bar-row">
      <div class="bar-label"><span>${p.nom}</span><span>${margeP} FCFA</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

// ---------------- BILANS MENSUELS ----------------
function renderBilansScreen() {
  const list = document.getElementById('bilans-list');
  if (bilansMensuels.length === 0) {
    list.innerHTML = '<div class="ticket empty" style="border:none; background:none;">Aucun bilan généré pour l\'instant</div>';
    return;
  }
  list.innerHTML = bilansMensuels.slice().reverse().map((b) => `
    <div class="bilan-card">
      <div class="bilan-head">
        <div class="bilan-mois">${b.mois}</div>
        ${b.genere_en_retard ? '<span class="badge-retard">Rattrapé au démarrage</span>' : ''}
      </div>
      <div class="bilan-grid">
        <div><div class="label">Chiffre d'affaires</div>${b.ca} FCFA</div>
        <div><div class="label">Coût ingrédients</div>−${b.cout} FCFA</div>
        <div><div class="label">Marge brute</div>${b.marge} FCFA</div>
        <div><div class="label">Charges fixes</div>−${b.charges} FCFA</div>
      </div>
      <div class="bilan-benefice">Bénéfice net : ${b.benefice} FCFA</div>
    </div>
  `).join('');
}

// Calcule et enregistre un bilan à partir des lignes non clôturées,
// puis les marque periode_cloturee = 1. Reproduit la logique de bhb_schema.sql.
async function genererBilan(mois, genereEnRetard) {
  const commandesOuvertes = commandesValidees.filter((l) => !l.periode_cloturee);
  const depensesOuvertes = depenses.filter((d) => !d.periode_cloturee);
  const chargesOuvertes = charges.filter((c) => !c.periode_cloturee);

  if (commandesOuvertes.length === 0 && depensesOuvertes.length === 0 && chargesOuvertes.length === 0) {
    return false;
  }

  const ca = commandesOuvertes.reduce((a, l) => a + l.montant, 0);
  const coutParProduit = {};
  depensesOuvertes.forEach((d) => {
    const part = d.montant / d.produits.length;
    d.produits.forEach((pid) => { coutParProduit[pid] = (coutParProduit[pid] || 0) + part; });
  });
  const cout = Object.values(coutParProduit).reduce((a, b) => a + b, 0);
  const marge = ca - cout;
  const chargesTotal = chargesOuvertes.filter((c) => c.type !== 'Épargne').reduce((a, c) => a + c.montant, 0);
  const benefice = marge - chargesTotal;

  const bilan = {
    id: nouvelId('bilan'),
    mois,
    ca, cout, marge, charges: chargesTotal, benefice,
    genere_en_retard: genereEnRetard ? 1 : 0,
    date_generation: new Date().toISOString(),
  };
  await dbPut('bilans_mensuels', bilan);
  bilansMensuels.push(bilan);

  commandesOuvertes.forEach((l) => l.periode_cloturee = 1);
  depensesOuvertes.forEach((d) => d.periode_cloturee = 1);
  chargesOuvertes.forEach((c) => c.periode_cloturee = 1);
  await dbBulkPut('commandes', commandesOuvertes);
  await dbBulkPut('depenses', depensesOuvertes);
  await dbBulkPut('charges', chargesOuvertes);

  return true;
}

async function clotureManuelle() {
  const mois = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const ok = await genererBilan(mois, false);
  if (!ok) { showToast('Rien à clôturer — tout est déjà figé'); return; }
  renderBilansScreen();
  renderDepensesList();
  renderChargesList();
  showToast('Mois clôturé — bilan généré ✓');
}

// Vérifie au démarrage si le mois précédent a été clôturé. Sinon, rattrape.
// (En usage réel, on comparerait aussi la date système à un dernier-mois-clôturé
// stocké ; ici on se base simplement sur la présence de données non clôturées
// datant d'un mois civil déjà terminé.)
async function verifierRattrapageCloture() {
  const maintenant = new Date();
  const moisEnCours = maintenant.getMonth();
  const anneeEnCours = maintenant.getFullYear();

  const aDesDonneesMoisPrecedent = [...depenses, ...charges, ...commandesValidees].some((item) => {
    if (item.periode_cloturee) return false;
    const d = new Date(item.date);
    return d.getFullYear() < anneeEnCours || (d.getFullYear() === anneeEnCours && d.getMonth() < moisEnCours);
  });

  if (aDesDonneesMoisPrecedent) {
    const moisPrecedent = new Date(anneeEnCours, moisEnCours - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const ok = await genererBilan(moisPrecedent, true);
    if (ok) showToast('Bilan du mois précédent rattrapé automatiquement');
  }
}

// ---------------- PWA : SERVICE WORKER + STATUT CONNEXION ----------------
function registrerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {
      // échec silencieux : l'app continue de fonctionner sans cache offline
    });
  }
}

function surveillerConnexion() {
  const badge = document.getElementById('offline-badge');
  function maj() {
    if (navigator.onLine) badge.classList.remove('show');
    else badge.classList.add('show');
  }
  window.addEventListener('online', maj);
  window.addEventListener('offline', maj);
  maj();
}

// ---------------- DÉMARRAGE ----------------
init();
