// app.js — logique de l'app BHB.
// Toutes les données sont persistées dans IndexedDB (voir idb.js),
// avec des noms de champs alignés sur bhb_schema.sql.

// ---------------- ÉTAT EN MÉMOIRE (miroir d'IndexedDB) ----------------
let produits = [];
let depenses = [];
let charges = [];
let commandesValidees = []; // lignes de vente : {id, factureId, clientNom, produitId, montant, date, periode_cloturee}
let bilansMensuels = [];    // bilans de tous types : {id, type:'jour'|'semaine'|'mois', libelle, ca, cout, marge, charges, benefice, genere_en_retard, date_generation}
let periodeActuelle = 'jour';    // pour Tableau de bord
let periodeFactures = 'jour';    // pour l'écran Factures
let bilanTypeAffiche = 'jour';   // filtre d'affichage de l'historique des bilans
let depProduitsSelectionnes = [];

// État du ticket en cours : plusieurs "clients" possibles sur une même facture
let ticket = {
  clients: [{ id: 'c1', nom: 'Client 1', items: {} }],
  activeClientId: 'c1',
};

const headerTitles = {
  commande: ['Commande', 'Beignet · Bouillie · Haricot'],
  depenses: ['Dépenses', 'Tout ce qui a été acheté'],
  charges: ['Charges', 'Loyer, salaire, imprévu, épargne'],
  dashboard: ['Tableau de bord', 'Bénéfice calculé en temps réel'],
  bilans: ['Bilans', 'Clôtures jour, semaine, mois'],
  factures: ['Factures', "L'historique de chaque vente"],
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

  renderClientTabs();
  renderProdGrid();
  renderTicket();
  await verifierRattrapageCloture();
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
  if (name === 'factures') renderFacturesScreen();
}

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1600);
}

// ---------------- ÉCRAN COMMANDE : GESTION MULTI-CLIENTS ----------------
function renderClientTabs() {
  const zone = document.getElementById('client-tabs');
  zone.innerHTML = ticket.clients.map((c) => `
    <div class="client-chip ${c.id === ticket.activeClientId ? 'active' : ''}" onclick="setActiveClient('${c.id}')">
      ${c.nom}
      ${ticket.clients.length > 1 ? `<span class="remove-x" onclick="event.stopPropagation(); retirerClient('${c.id}')">✕</span>` : ''}
    </div>
  `).join('') + `<div class="client-chip add-chip" onclick="ajouterClient()">+ Client</div>`;
}

function setActiveClient(id) {
  ticket.activeClientId = id;
  renderClientTabs();
  renderProdGrid();
}

function ajouterClient() {
  const n = ticket.clients.length + 1;
  const nouveau = { id: 'c' + Date.now(), nom: 'Client ' + n, items: {} };
  ticket.clients.push(nouveau);
  ticket.activeClientId = nouveau.id;
  renderClientTabs();
  renderProdGrid();
}

function retirerClient(id) {
  ticket.clients = ticket.clients.filter((c) => c.id !== id);
  if (ticket.activeClientId === id) ticket.activeClientId = ticket.clients[0].id;
  renderClientTabs();
  renderProdGrid();
  renderTicket();
}

function clientActif() {
  return ticket.clients.find((c) => c.id === ticket.activeClientId);
}

// ---------------- ÉCRAN COMMANDE : PRODUITS ----------------
function renderProdGrid() {
  const grid = document.getElementById('prod-grid');
  const client = clientActif();
  grid.innerHTML = '';
  produits.forEach((p) => {
    const montant = client.items[p.id] || '';
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
  const client = clientActif();
  if (!val || val <= 0) delete client.items[id];
  else client.items[id] = val;
  renderProdGrid();
  renderTicket();
}

function renderTicket() {
  const linesEl = document.getElementById('ticket-lines');
  const clientsAvecItems = ticket.clients.filter((c) => Object.keys(c.items).length > 0);

  if (clientsAvecItems.length === 0) {
    linesEl.innerHTML = '<div class="empty">Aucun article sélectionné</div>';
    document.getElementById('ticket-total').textContent = '0 FCFA';
    document.getElementById('btn-valider').disabled = true;
    return;
  }

  let total = 0;
  const afficherNomClient = clientsAvecItems.length > 1;
  linesEl.innerHTML = clientsAvecItems.map((c) => {
    let sousTotal = 0;
    const lignesHtml = Object.keys(c.items).map((id) => {
      const p = produits.find((x) => x.id === id);
      const montant = c.items[id];
      const qteApprox = (montant / p.prix).toFixed(1);
      sousTotal += montant;
      return `<div class="line"><span>${p.nom} (≈${qteApprox} u.)</span><span>${montant} FCFA</span></div>`;
    }).join('');
    total += sousTotal;
    return `<div class="client-groupe">
      ${afficherNomClient ? `<div class="client-nom">${c.nom} — ${sousTotal} FCFA</div>` : ''}
      ${lignesHtml}
    </div>`;
  }).join('');

  document.getElementById('ticket-total').textContent = total + ' FCFA';
  document.getElementById('btn-valider').disabled = false;
}

async function validerCommande() {
  const now = new Date().toISOString();
  const factureId = nouvelId('facture');
  const clientsAvecItems = ticket.clients.filter((c) => Object.keys(c.items).length > 0);
  const multiClients = clientsAvecItems.length > 1;

  const nouvelles = [];
  clientsAvecItems.forEach((c) => {
    Object.keys(c.items).forEach((id) => {
      const p = produits.find((x) => x.id === id);
      const montant = c.items[id];
      nouvelles.push({
        id: nouvelId('cmd'),
        factureId,
        clientNom: multiClients ? c.nom : null,
        produitId: id,
        montant,
        quantiteApprox: montant / p.prix,
        prixUnitaire: p.prix,
        date: now,
        periode_cloturee: 0,
      });
    });
  });

  await dbBulkPut('commandes', nouvelles);
  commandesValidees.push(...nouvelles);

  ticket = { clients: [{ id: 'c1', nom: 'Client 1', items: {} }], activeClientId: 'c1' };
  renderClientTabs();
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

// ---------------- ÉCRAN FACTURES ----------------
function grouperFactures(lignes) {
  const groupes = {};
  lignes.forEach((l) => {
    const cle = l.factureId || l.id; // repli pour les anciennes lignes sans factureId
    if (!groupes[cle]) groupes[cle] = { id: cle, date: l.date, periode_cloturee: l.periode_cloturee, lignes: [] };
    groupes[cle].lignes.push(l);
  });
  return Object.values(groupes).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function setFacturePeriod(p) {
  periodeFactures = p;
  document.querySelectorAll('#facture-period-tabs .period-tab').forEach((b) => b.classList.remove('active'));
  document.querySelector('#facture-period-tabs .period-tab[data-period="' + p + '"]').classList.add('active');
  renderFacturesScreen();
}

function renderFacturesScreen() {
  const debut = debutPeriode(periodeFactures);
  const labels = { jour: "Aujourd'hui", semaine: 'Depuis lundi ' + formatDateCourt(debut), mois: 'Depuis le ' + formatDateCourt(debut) };
  document.getElementById('facture-period-range').textContent = labels[periodeFactures];

  const lignesFiltrees = commandesValidees.filter((l) => new Date(l.date) >= debut);
  const factures = grouperFactures(lignesFiltrees);
  const zone = document.getElementById('factures-list');

  if (factures.length === 0) {
    zone.innerHTML = '<div class="ticket empty" style="border:none; background:none;">Aucune facture sur cette période</div>';
    return;
  }

  zone.innerHTML = factures.map((f) => {
    const heure = new Date(f.date).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const total = f.lignes.reduce((a, l) => a + l.montant, 0);
    const parClient = {};
    f.lignes.forEach((l) => {
      const cle = l.clientNom || '__seul__';
      if (!parClient[cle]) parClient[cle] = [];
      parClient[cle].push(l);
    });
    const multiClients = Object.keys(parClient).length > 1;

    const corpsHtml = Object.keys(parClient).map((cle) => {
      const lignesClient = parClient[cle];
      const sousTotal = lignesClient.reduce((a, l) => a + l.montant, 0);
      const lignesHtml = lignesClient.map((l) => {
        const p = produits.find((x) => x.id === l.produitId);
        return `<div class="line"><span>${p ? p.nom : '?'}</span><span>${l.montant} FCFA</span></div>`;
      }).join('');
      return `<div class="client-groupe">
        ${multiClients ? `<div class="client-nom">${cle} — ${sousTotal} FCFA</div>` : ''}
        ${lignesHtml}
      </div>`;
    }).join('');

    return `<div class="bilan-card">
      <div class="bilan-head">
        <div class="bilan-mois" style="text-transform:none;">${heure}</div>
        ${f.periode_cloturee ? '<span class="lock-icon">🔒</span>' : `<span class="delete-btn" onclick="supprimerFacture('${f.id}')">🗑 Supprimer</span>`}
      </div>
      ${corpsHtml}
      <div class="bilan-benefice">Total : ${total} FCFA</div>
    </div>`;
  }).join('');
}

async function supprimerFacture(factureId) {
  if (!confirm('Supprimer cette facture ? Cette action est définitive.')) return;
  const lignes = commandesValidees.filter((l) => (l.factureId || l.id) === factureId);
  for (const l of lignes) {
    await dbDelete('commandes', l.id);
  }
  commandesValidees = commandesValidees.filter((l) => (l.factureId || l.id) !== factureId);
  renderFacturesScreen();
  showToast('Facture supprimée');
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
    const suppr = d.periode_cloturee ? '' : `<span class="delete-btn" onclick="supprimerDepense('${d.id}')">🗑</span>`;
    return `<div class="list-item ${lockCls}">
      <div><div class="li-name">${lockIcon}${d.libelle}</div><div class="li-meta">${noms}</div></div>
      <div style="display:flex; align-items:center; gap:10px;">
        <div class="li-amount chili">−${d.montant}</div>
        ${suppr}
      </div>
    </div>`;
  }).join('');
}

async function supprimerDepense(id) {
  if (!confirm('Supprimer cette dépense ?')) return;
  await dbDelete('depenses', id);
  depenses = depenses.filter((d) => d.id !== id);
  renderDepensesList();
  showToast('Dépense supprimée');
}

// ---------------- ÉCRAN CHARGES ----------------
async function ajouterCharge() {
  const libelle = document.getElementById('charge-libelle').value.trim();
  const type = document.getElementById('charge-type').value;
  const montant = parseFloat(document.getElementById('charge-montant').value);
  if (!libelle || !montant) { showToast('Libellé et montant requis'); return; }
  const nouvelleCharge = {
    id: nouvelId('chg'),
    libelle,
    type,
    montant,
    statut: 'du',
    date: new Date().toISOString(),
    periode_cloturee: 0,
  };
  await dbPut('charges', nouvelleCharge);
  charges.push(nouvelleCharge);
  document.getElementById('charge-libelle').value = '';
  document.getElementById('charge-montant').value = '';
  closeModal('modal-charge');
  renderChargesList();
  showToast('Achat enregistré');
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
  if (charges.length === 0) { list.innerHTML = '<div class="ticket empty" style="border:none; background:none;">Aucun achat enregistré</div>'; return; }
  list.innerHTML = charges.slice().reverse().map((c) => {
    const lockCls = c.periode_cloturee ? 'locked' : '';
    const lockIcon = c.periode_cloturee ? '<span class="lock-icon">🔒</span>' : '';
    const libelle = c.libelle || c.type; // repli pour les anciennes charges sans libellé
    const suppr = c.periode_cloturee ? '' : `<span class="delete-btn" onclick="supprimerCharge(event, '${c.id}')">🗑</span>`;
    return `<div class="list-item ${lockCls}" onclick="toggleChargeStatut('${c.id}')" style="cursor:${c.periode_cloturee ? 'default' : 'pointer'};">
      <div><div class="li-name">${lockIcon}${libelle}</div><div class="li-meta">${c.type} · <span class="status-tag ${c.statut}">${c.statut === 'paye' ? 'Payé' : 'Dû'}</span></div></div>
      <div style="display:flex; align-items:center; gap:10px;">
        <div class="li-amount chili">${c.montant} FCFA</div>
        ${suppr}
      </div>
    </div>`;
  }).join('');
}

async function supprimerCharge(event, id) {
  event.stopPropagation();
  if (!confirm('Supprimer cette charge ?')) return;
  await dbDelete('charges', id);
  charges = charges.filter((c) => c.id !== id);
  renderChargesList();
  showToast('Charge supprimée');
}

// ---------------- OUTILS DE PÉRIODE (partagés Tableau / Factures / Bilans) ----------------
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

// Épargne totale accumulée depuis le début — jamais filtrée par période,
// car c'est un solde cumulé, pas un flux de la période.
function calculerEpargneTotale() {
  return charges.filter((c) => c.type === 'Épargne').reduce((a, c) => a + c.montant, 0);
}

// Solde veille : uniquement le total des commandes (ventes) d'HIER — le jour calendaire
// précédent, rien d'autre. Pas de déduction, pas de cascade sur les jours antérieurs.
// C'est un point de départ figé pour la journée, recalculé chaque matin.
function calculerSoldeVeille() {
  const debutAujourdhui = debutPeriode('jour');
  const debutHier = new Date(debutAujourdhui);
  debutHier.setDate(debutHier.getDate() - 1);
  return commandesValidees
    .filter((l) => { const d = new Date(l.date); return d >= debutHier && d < debutAujourdhui; })
    .reduce((a, l) => a + l.montant, 0);
}

// CA en direct pour "Jour" : part du solde veille (figé), puis bouge avec les
// mouvements d'aujourd'hui — ventes en plus, dépenses/charges/achats/épargne en moins.
function calculerCALiveDuJour() {
  const soldeVeille = calculerSoldeVeille();
  const debut = debutPeriode('jour');
  const ventesAujourdhui = commandesValidees.filter((l) => new Date(l.date) >= debut).reduce((a, l) => a + l.montant, 0);
  const depensesAujourdhui = depenses.filter((d) => new Date(d.date) >= debut).reduce((a, d) => a + d.montant, 0);
  const chargesAujourdhui = charges.filter((c) => new Date(c.date) >= debut).reduce((a, c) => a + c.montant, 0);
  return soldeVeille + ventesAujourdhui - depensesAujourdhui - chargesAujourdhui;
}

// ---------------- TABLEAU DE BORD ----------------
function setPeriod(periode) {
  periodeActuelle = periode;
  document.querySelectorAll('#period-tabs .period-tab').forEach((b) => b.classList.remove('active'));
  document.querySelector('#period-tabs .period-tab[data-period="' + periode + '"]').classList.add('active');
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

  // Coût des ingrédients : uniquement global, jamais réparti par produit
  // (une répartition précise par produit n'a pas de sens au jour le jour).
  const coutTotal = depensesFiltrees.reduce((a, d) => a + d.montant, 0);

  const margeBrute = ca - coutTotal;
  const chargesTotal = chargesFiltrees.reduce((a, c) => a + c.montant, 0);
  const epargne = chargesFiltrees.filter((c) => c.type === 'Épargne').reduce((a, c) => a + c.montant, 0);
  const beneficeNet = margeBrute - chargesTotal;

  document.getElementById('kpi-ca').textContent = (periodeActuelle === 'jour' ? calculerCALiveDuJour() : ca) + ' FCFA';
  document.getElementById('kpi-cout').textContent = '−' + coutTotal + ' FCFA';
  document.getElementById('kpi-marge').textContent = margeBrute + ' FCFA';
  document.getElementById('kpi-charges').textContent = '−' + chargesTotal + ' FCFA';
  document.getElementById('kpi-benefice').textContent = beneficeNet + ' FCFA';
  document.getElementById('kpi-solde-veille').textContent = calculerSoldeVeille() + ' FCFA';
  document.getElementById('epargne-note').textContent = 'Dont épargne sur la période : ' + epargne + ' FCFA — déjà déduite du bénéfice ci-dessus.';
  document.getElementById('epargne-totale-note').textContent = 'Épargne totale accumulée : ' + calculerEpargneTotale() + ' FCFA';

  // Barres : chiffre d'affaires par produit uniquement (pas de coût attribué)
  const bars = document.getElementById('marge-bars');
  const maxCA = Math.max(1, ...Object.values(caParProduit));
  bars.innerHTML = produits.map((p) => {
    const pct = Math.max(0, (caParProduit[p.id] / maxCA) * 100);
    return `<div class="bar-row">
      <div class="bar-label"><span>${p.nom}</span><span>${caParProduit[p.id]} FCFA</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

// ---------------- BILANS : JOUR / SEMAINE / MOIS ----------------
// "jour" et "semaine" sont des instantanés informatifs (recalculés depuis les lignes brutes,
// comme le Tableau de bord) — rien n'est verrouillé. Seul "mois" est la clôture officielle :
// elle verrouille les lignes concernées (periode_cloturee = 1) pour figer l'historique.

function calculerAgregats(lignesCmd, lignesDep, lignesChg) {
  const ca = lignesCmd.reduce((a, l) => a + l.montant, 0);
  const cout = lignesDep.reduce((a, d) => a + d.montant, 0);
  const marge = ca - cout;
  const chargesTotal = lignesChg.reduce((a, c) => a + c.montant, 0);
  const benefice = marge - chargesTotal;
  return { ca, cout, marge, charges: chargesTotal, benefice };
}

function setBilanType(type) {
  bilanTypeAffiche = type;
  document.querySelectorAll('#bilan-type-tabs .period-tab').forEach((b) => b.classList.remove('active'));
  document.querySelector('#bilan-type-tabs .period-tab[data-type="' + type + '"]').classList.add('active');
  renderBilansScreen();
}

function renderBilansScreen() {
  document.getElementById('bilan-epargne-totale-note').textContent = 'Épargne totale accumulée : ' + calculerEpargneTotale() + ' FCFA';
  const list = document.getElementById('bilans-list');
  const filtres = bilansMensuels.filter((b) => b.type === bilanTypeAffiche);
  if (filtres.length === 0) {
    list.innerHTML = '<div class="ticket empty" style="border:none; background:none;">Aucun bilan généré pour l\'instant</div>';
    return;
  }
  list.innerHTML = filtres.slice().reverse().map((b) => `
    <div class="bilan-card">
      <div class="bilan-head">
        <div class="bilan-mois">${b.libelle}</div>
        ${b.genere_en_retard ? '<span class="badge-retard">Rattrapé au démarrage</span>' : ''}
      </div>
      <div class="bilan-grid">
        <div><div class="label">Chiffre d'affaires</div>${b.ca} FCFA</div>
        <div><div class="label">Coût ingrédients</div>−${b.cout} FCFA</div>
        <div><div class="label">Marge brute</div>${b.marge} FCFA</div>
        <div><div class="label">Charges fixes</div>−${b.charges} FCFA</div>
      </div>
      ${b.detailDepenses && b.detailDepenses.length ? `
        <div class="bilan-detail-title">Dépenses (${b.detailDepenses.length})</div>
        ${b.detailDepenses.map((d) => `<div class="line"><span>${d.libelle}</span><span>−${d.montant} FCFA</span></div>`).join('')}
      ` : ''}
      ${b.detailCharges && b.detailCharges.length ? `
        <div class="bilan-detail-title">Charges (${b.detailCharges.length})</div>
        ${b.detailCharges.map((c) => `<div class="line"><span>${c.libelle}</span><span>−${c.montant} FCFA</span></div>`).join('')}
      ` : ''}
      <div class="bilan-benefice">Bénéfice net : ${b.benefice} FCFA</div>
    </div>
  `).join('');
}

// Snapshot jour/semaine — ne verrouille rien, purement informatif.
async function genererBilanSnapshot(type, libelle, debut, fin, genereEnRetard) {
  const lignesCmd = commandesValidees.filter((l) => { const d = new Date(l.date); return d >= debut && d < fin; });
  const lignesDep = depenses.filter((d) => { const dt = new Date(d.date); return dt >= debut && dt < fin; });
  const lignesChg = charges.filter((c) => { const dt = new Date(c.date); return dt >= debut && dt < fin; });

  if (lignesCmd.length === 0 && lignesDep.length === 0 && lignesChg.length === 0) return false;

  const agg = calculerAgregats(lignesCmd, lignesDep, lignesChg);
  const bilan = {
    id: nouvelId('bilan'),
    type,
    libelle,
    ...agg,
    detailDepenses: lignesDep.map((d) => ({ libelle: d.libelle, montant: d.montant })),
    detailCharges: lignesChg.map((c) => ({ libelle: c.libelle || c.type, montant: c.montant })),
    genere_en_retard: genereEnRetard ? 1 : 0,
    date_generation: new Date().toISOString(),
  };
  await dbPut('bilans_mensuels', bilan);
  bilansMensuels.push(bilan);
  return true;
}

// Clôture mensuelle officielle — verrouille les lignes concernées.
async function genererBilanMensuelOfficiel(libelle, genereEnRetard) {
  const commandesOuvertes = commandesValidees.filter((l) => !l.periode_cloturee);
  const depensesOuvertes = depenses.filter((d) => !d.periode_cloturee);
  const chargesOuvertes = charges.filter((c) => !c.periode_cloturee);

  if (commandesOuvertes.length === 0 && depensesOuvertes.length === 0 && chargesOuvertes.length === 0) return false;

  const agg = calculerAgregats(commandesOuvertes, depensesOuvertes, chargesOuvertes);
  const bilan = {
    id: nouvelId('bilan'),
    type: 'mois',
    libelle,
    ...agg,
    detailDepenses: depensesOuvertes.map((d) => ({ libelle: d.libelle, montant: d.montant })),
    detailCharges: chargesOuvertes.map((c) => ({ libelle: c.libelle || c.type, montant: c.montant })),
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

async function clotureManuelle(type) {
  let ok;
  if (type === 'jour') {
    const debut = debutPeriode('jour');
    const fin = new Date(debut); fin.setDate(fin.getDate() + 1);
    const libelle = debut.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long' });
    ok = await genererBilanSnapshot('jour', libelle, debut, fin, false);
  } else if (type === 'semaine') {
    const debut = debutPeriode('semaine');
    const fin = new Date(debut); fin.setDate(fin.getDate() + 7);
    const libelle = 'Semaine du ' + formatDateCourt(debut) + ' au ' + formatDateCourt(new Date(fin - 1));
    ok = await genererBilanSnapshot('semaine', libelle, debut, fin, false);
  } else {
    const libelle = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    ok = await genererBilanMensuelOfficiel(libelle, false);
  }

  if (!ok) { showToast('Rien à clôturer pour cette période'); return; }
  bilanTypeAffiche = type;
  renderBilansScreen();
  renderDepensesList();
  renderChargesList();
  showToast('Clôture (' + type + ') générée ✓');
}

// Vérifie au démarrage : jour précédent, semaine précédente, et mois précédent
// non encore clôturés → rattrapage automatique et silencieux (sauf toast).
async function verifierRattrapageCloture() {
  const maintenant = new Date();

  // -- Jour précédent --
  const hier = new Date(maintenant); hier.setDate(hier.getDate() - 1); hier.setHours(0, 0, 0, 0);
  const finHier = new Date(hier); finHier.setDate(finHier.getDate() + 1);
  const libelleHier = hier.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long' });
  const dejaJour = bilansMensuels.some((b) => b.type === 'jour' && b.libelle === libelleHier);
  if (!dejaJour) {
    const ok = await genererBilanSnapshot('jour', libelleHier, hier, finHier, true);
    if (ok) showToast('Bilan du jour précédent rattrapé');
  }

  // -- Semaine précédente --
  const debutSemaineEnCours = debutPeriode('semaine');
  const debutSemainePrecedente = new Date(debutSemaineEnCours); debutSemainePrecedente.setDate(debutSemainePrecedente.getDate() - 7);
  const finSemainePrecedente = new Date(debutSemaineEnCours);
  const libelleSemaine = 'Semaine du ' + formatDateCourt(debutSemainePrecedente) + ' au ' + formatDateCourt(new Date(finSemainePrecedente - 1));
  const dejaSemaine = bilansMensuels.some((b) => b.type === 'semaine' && b.libelle === libelleSemaine);
  if (!dejaSemaine && debutSemainePrecedente < maintenant) {
    const ok = await genererBilanSnapshot('semaine', libelleSemaine, debutSemainePrecedente, finSemainePrecedente, true);
    if (ok) showToast('Bilan de la semaine précédente rattrapé');
  }

  // -- Mois précédent (officiel, verrouille) --
  const moisEnCours = maintenant.getMonth();
  const anneeEnCours = maintenant.getFullYear();
  const aDesDonneesMoisPrecedent = [...depenses, ...charges, ...commandesValidees].some((item) => {
    if (item.periode_cloturee) return false;
    const d = new Date(item.date);
    return d.getFullYear() < anneeEnCours || (d.getFullYear() === anneeEnCours && d.getMonth() < moisEnCours);
  });
  if (aDesDonneesMoisPrecedent) {
    const moisPrecedent = new Date(anneeEnCours, moisEnCours - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const ok = await genererBilanMensuelOfficiel(moisPrecedent, true);
    if (ok) showToast('Bilan du mois précédent rattrapé');
  }
}

// ---------------- PWA : SERVICE WORKER + STATUT CONNEXION ----------------
function registrerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
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
