/**
 * ScenarioUnderstandingService
 * ----------------------------
 * Analyzes real-life scenarios and maps them to:
 * - Protected wildlife involved
 * - Possible offences under WLPA
 * - Applicable sections
 * - Practical steps for the user
 * - Whether to recommend Forest Department
 *
 * Uses keyword matching, entity extraction, and pattern recognition
 * from the incident_patterns.json knowledge base.
 */

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

class ScenarioUnderstandingService {
  constructor() {
    this.patterns = null;
    this.speciesData = null;
    this.sectionsData = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      const dataDir = path.join(process.cwd(), 'src', 'data');

      // Load incident patterns
      const patternsPath = path.join(dataDir, 'incident_patterns.json');
      if (fs.existsSync(patternsPath)) {
        this.patterns = JSON.parse(fs.readFileSync(patternsPath, 'utf8')).incidentPatterns;
      }

      // Load species for quick lookup
      const speciesPath = path.join(dataDir, 'species.json');
      if (fs.existsSync(speciesPath)) {
        this.speciesData = JSON.parse(fs.readFileSync(speciesPath, 'utf8')).species;
      }

      // Load sections for reference
      const sectionsPath = path.join(dataDir, 'sections.json');
      if (fs.existsSync(sectionsPath)) {
        this.sectionsData = JSON.parse(fs.readFileSync(sectionsPath, 'utf8')).sections;
      }

      this.initialized = true;
      logger.info('ScenarioUnderstandingService: Initialized');
    } catch (err) {
      logger.error('ScenarioUnderstandingService: Initialization failed', { error: err.message });
    }
  }

  /**
   * Analyze a scenario description and return structured understanding.
   * @param {string} scenarioText - User's description of the situation
   * @param {string} language - Language code
   * @returns {Object} Structured analysis
   */
  async analyzeScenario(scenarioText, language = 'en') {
    if (!this.initialized) await this.initialize();

    const normalized = scenarioText.toLowerCase();

    // 1. Identify incident type
    const incidentType = this._identifyIncidentType(normalized);

    // 2. Extract species mentioned
    const species = this._extractSpecies(normalized);

    // 3. Extract location/context clues
    const context = this._extractContext(normalized);

    // 4. Determine applicable sections
    const applicableSections = this._determineApplicableSections(incidentType, species, context);

    // 5. Determine possible offences
    const offences = this._determineOffences(incidentType, species, context);

    // 6. Generate practical steps
    const practicalSteps = this._generatePracticalSteps(incidentType, species, context, language);

    // 7. Determine if Forest Dept should be contacted
    const needsForestDept = this._needsForestDepartment(incidentType, species, context);

    // 8. Assess severity
    const severity = this._assessSeverity(incidentType, species, context);

    return {
      incidentType,
      species,
      context,
      applicableSections,
      offences,
      practicalSteps,
      needsForestDept,
      severity,
      confidence: this._calculateConfidence(incidentType, species, context),
      language,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Identify the type of incident from keywords.
   */
  _identifyIncidentType(text) {
    const scores = {};

    if (!this.patterns) return 'unknown';

    for (const [key, pattern] of Object.entries(this.patterns)) {
      let score = 0;

      // Check keywords
      if (pattern.keywords) {
        for (const keyword of pattern.keywords) {
          if (text.includes(keyword.toLowerCase())) {
            score += 3;
          }
        }
      }

      // Check scenarios
      if (pattern.scenarios) {
        for (const scenario of pattern.scenarios) {
          const scenarioWords = scenario.toLowerCase().split(/\s+/);
          const matches = scenarioWords.filter(w => w.length > 3 && text.includes(w)).length;
          score += matches;
        }
      }

      if (score > 0) scores[key] = score;
    }

    // Special handling for human-wildlife conflict detection
    // If text mentions livestock/crop damage + animal, prioritize human_wildlife_conflict
    const hasLivestockConflict = /\b(goat|cow|cattle|livestock|sheep|chicken|hen|duck|farm|crop|field)\b/.test(text);
    const hasAnimal = /\b(tiger|leopard|elephant|bear|wolf|wild boar|nilgai|wild animal|predator)\b/.test(text);
    const hasHumanInvolvement = /\b(village|villager|farmer|people|human|man|woman|child|children)\b/.test(text);

    // Exclude "calf" when it refers to elephant/elephant calf (wild animal young)
    const isElephantCalf = /\belephant calf\b/.test(text) || /\bcalf\b.*\belephant\b/.test(text) || /\belephant\b.*\bcalf\b/.test(text);
    const isLivestockCalf = /\bcalf\b/.test(text) && !isElephantCalf;

    const effectiveLivestockConflict = hasLivestockConflict || isLivestockCalf;

    if (effectiveLivestockConflict && hasAnimal && hasHumanInvolvement) {
      scores.human_wildlife_conflict = (scores.human_wildlife_conflict || 0) + 10;
    }

    // If text mentions "killed" + livestock + animal, it's likely conflict not poaching
    const hasKilledLivestock = /\b(killed|attacked|injured)\b/.test(text) && effectiveLivestockConflict && hasAnimal;
    if (hasKilledLivestock) {
      scores.human_wildlife_conflict = (scores.human_wildlife_conflict || 0) + 15;
      scores.poaching = Math.max(0, (scores.poaching || 0) - 10);
    }

    if (Object.keys(scores).length === 0) return 'unknown';

    // Return highest scoring incident type
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  }

  /**
   * Extract species mentioned in the text.
   */
  _extractSpecies(text) {
    const found = [];

    if (!this.speciesData) return found;

    // Additional aliases for common species
    const speciesAliases = {
      'leopard': ['leopard', 'panther', 'tendua', 'bibtya'],
      'tiger': ['tiger', 'baagh', 'wagh', 'sher'],
      'elephant': ['elephant', 'hathi', 'hatti'],
      'heron': ['heron', 'bagula', 'bagla'],
      'peafowl': ['peafowl', 'peacock', 'mor'],
      'python': ['python', 'ajgar'],
      'cobra': ['cobra', 'nag', 'naag'],
      'gharial': ['gharial', 'gavial'],
      'pangolin': ['pangolin', 'scaly anteater', 'khavyа manjаr'],
      'deer': ['deer', 'hiran', 'harin'],
      'antelope': ['antelope', 'hiran'],
      'bear': ['bear', 'bhalu', 'aswal'],
      'wolf': ['wolf', 'bhediya'],
      'fox': ['fox', 'lomdi'],
      'monkey': ['monkey', 'bandar', 'makad'],
      'langur': ['langur', 'hanuman langur'],
      'macaque': ['macaque', 'monkey'],
      'boar': ['boar', 'wild boar', 'wild pig', 'jangli suar'],
      'nilgai': ['nilgai', 'blue bull', 'roj'],
      'rhino': ['rhino', 'rhinoceros', 'gainda'],
      'lion': ['lion', 'sher', 'asiatic lion'],
      'snow leopard': ['snow leopard', 'him tendua', 'ounce'],
      'clouded leopard': ['clouded leopard', 'megh baagh'],
      'red panda': ['red panda', 'firefox'],
      'sloth bear': ['sloth bear', 'bhalu', 'aswal'],
      'wild buffalo': ['wild buffalo', 'wild water buffalo', 'mahish'],
      'swamp deer': ['swamp deer', 'barasingha', 'barahsinga'],
      'hangul': ['hangul', 'kashmir stag'],
      'nilgiri tahr': ['nilgiri tahr', 'nilgiri ibex'],
      'gangetic dolphin': ['gangetic dolphin', 'susu', 'soons'],
      'marine turtle': ['marine turtle', 'sea turtle', 'samudri kachua'],
      'king cobra': ['king cobra', 'raja naag'],
      'indian python': ['indian python', 'rock python', 'ajgar'],
      'indian pangolin': ['indian pangolin', 'pangolin', 'scaly anteater'],
      'chinkara': ['chinkara', 'indian gazelle', 'chinkara'],
      'four horned antelope': ['four horned antelope', 'chousingha', 'chausingha'],
      'tibetan antelope': ['tibetan antelope', 'chiru'],
      'himalayan musk deer': ['himalayan musk deer', 'musk deer', 'kasturi mrig'],
      'dhole': ['dhole', 'wild dog', 'jungli kutta'],
      'hoolock gibbon': ['hoolock gibbon', 'gibbon', 'hoolock'],
      'lion tailed macaque': ['lion tailed macaque', 'lion-tailed macaque'],
      'nilgiri langur': ['nilgiri langur', 'nilgiri monkey'],
      'golden langur': ['golden langur', 'gee langur'],
      'red sandalwood': ['red sandalwood', 'rakt chandan', 'red sanders'],
      'sandalwood': ['sandalwood', 'chandan'],
      'agarwood': ['agarwood', 'agar', 'oudh', 'eaglewood'],
      'orchid': ['orchid', 'orchids'],
      'heron': ['heron', 'egret', 'bagula', 'bagla', 'grey heron', 'purple heron', 'pond heron'],
      'crane': ['crane', 'sarus crane', 'demoiselle crane'],
      'stork': ['stork', 'painted stork', 'openbill stork'],
      'ibis': ['ibis', 'black ibis', 'red-naped ibis'],
      'flamingo': ['flamingo', 'greater flamingo', 'lesser flamingo'],
      'pelican': ['pelican', 'spot-billed pelican', 'great white pelican'],
      'duck': ['duck', 'teal', 'pintail', 'shoveler', 'wigeon'],
      'goose': ['goose', 'bar-headed goose', 'greylag goose'],
      'vulture': ['vulture', 'white-rumped vulture', 'indian vulture', 'slender-billed vulture', 'red-headed vulture', 'egyptian vulture', 'cinereous vulture', 'griffon vulture', 'himalayan griffon'],
      'eagle': ['eagle', 'tawny eagle', 'steppe eagle', 'bonelli eagle', 'crested serpent eagle'],
      'kite': ['kite', 'black kite', 'brahminy kite'],
      'falcon': ['falcon', 'peregrine falcon', 'laggar falcon', 'red-necked falcon'],
      'owl': ['owl', 'barn owl', 'spotted owlet', 'eagle owl', 'fish owl'],
      'hornbill': ['hornbill', 'great hornbill', 'indian grey hornbill', 'malabar grey hornbill', 'wreathed hornbill'],
      'parakeet': ['parakeet', 'rose-ringed parakeet', 'plum-headed parakeet', 'alexandrine parakeet'],
      'myna': ['myna', 'common myna', 'bank myna', 'jungle myna'],
      'bulbul': ['bulbul', 'red-vented bulbul', 'red-whiskered bulbul', 'white-browed bulbul'],
      'drongo': ['drongo', 'black drongo', 'white-bellied drongo', 'greater racket-tailed drongo'],
      'kingfisher': ['kingfisher', 'common kingfisher', 'white-throated kingfisher', 'pied kingfisher'],
      'woodpecker': ['woodpecker', 'flameback', 'golden-backed woodpecker', 'lesser goldenback'],
      'bee-eater': ['bee-eater', 'green bee-eater', 'blue-tailed bee-eater'],
      'roller': ['roller', 'indian roller', 'european roller'],
      'hoopoe': ['hoopoe', 'common hoopoe'],
      'cuckoo': ['cuckoo', 'koel', 'asian koel', 'brainfever bird'],
      'swift': ['swift', 'house swift', 'palm swift', 'crested treeswift'],
      'swallow': ['swallow', 'barn swallow', 'wire-tailed swallow', 'red-rumped swallow'],
      'martin': ['martin', 'dusky crag martin', 'plain martin'],
      'wagtail': ['wagtail', 'white wagtail', 'yellow wagtail', 'grey wagtail'],
      'pipit': ['pipit', 'paddyfield pipit', 'richards pipit'],
      'lark': ['lark', 'skylark', 'crested lark', 'bush lark'],
      'warbler': ['warbler', 'tailorbird', 'prinia', 'cisticola', 'acrocephalus'],
      'flycatcher': ['flycatcher', 'paradise flycatcher', 'verditer flycatcher', 'tickell blue flycatcher'],
      'sunbird': ['sunbird', 'purple sunbird', 'crimson-backed sunbird', 'lotens sunbird'],
      'flowerpecker': ['flowerpecker', 'thick-billed flowerpecker', 'pale-billed flowerpecker'],
      'white-eye': ['white-eye', 'oriental white-eye', 'indian white-eye'],
      'munia': ['munia', 'scaly-breasted munia', 'white-rumped munia', 'black-throated munia'],
      'weaver': ['weaver', 'baya weaver', 'streaked weaver', 'black-breasted weaver'],
      'sparrow': ['sparrow', 'house sparrow', 'spanish sparrow', 'russet sparrow'],
      'finch': ['finch', 'red avadavat', 'indian silverbill', 'white-throated munia'],
      'bunting': ['bunting', 'crested bunting', 'grey-necked bunting'],
      'shrike': ['shrike', 'long-tailed shrike', 'bay-backed shrike', 'brown shrike'],
      'oriole': ['oriole', 'indian golden oriole', 'black-hooded oriole'],
      'minivet': ['minivet', 'small minivet', 'scarlet minivet', 'long-tailed minivet'],
      'cuckooshrike': ['cuckooshrike', 'large cuckooshrike', 'black-headed cuckooshrike'],
      'iola': ['iola', 'golden iola', 'marshall iola'],
      'leafbird': ['leafbird', 'golden-fronted leafbird', 'jerdons leafbird'],
      'fairy-bluebird': ['fairy-bluebird', 'asian fairy-bluebird'],
      'shama': ['shama', 'white-rumped shama', 'white-browed shama'],
      'robin': ['robin', 'indian robin', 'oriental magpie-robin', 'white-browed robin'],
      'redstart': ['redstart', 'blue-fronted redstart', 'plumbeous redstart', 'white-capped redstart'],
      'forktail': ['forktail', 'little forktail', 'slaty-backed forktail'],
      'whistling thrush': ['whistling thrush', 'malabar whistling thrush', 'blue whistling thrush'],
      'chat': ['chat', 'indian chat', 'brown rock chat', 'pied bushchat'],
      'wheatear': ['wheatear', 'desert wheatear', 'isabelline wheatear', 'pied wheatear'],
      'rock thrush': ['rock thrush', 'blue rock thrush', 'chestnut-bellied rock thrush'],
      'thrush': ['thrush', 'tickell thrush', 'orange-headed thrush', 'scaly thrush'],
      'babbler': ['babbler', 'jungle babbler', 'large grey babbler', 'common babbler', 'yellow-eyed babbler'],
      'tit': ['tit', 'great tit', 'cinereous tit', 'yellow-cheeked tit'],
      'nuthatch': ['nuthatch', 'velvet-fronted nuthatch', 'chestnut-bellied nuthatch'],
      'treecreeper': ['treecreeper', 'brown treecreeper', 'himalayan treecreeper'],
      'wren': ['wren', 'winter wren'],
      'dipper': ['dipper', 'brown dipper', 'white-throated dipper'],
      'accentor': ['accentor', 'robin accentor', 'rufous-breasted accentor'],
      'piping': ['piping', 'piping hornbill'],
      'hornbill': ['hornbill', 'great hornbill', 'indian grey hornbill', 'malabar grey hornbill', 'wreathed hornbill', 'rufous-necked hornbill', 'narcondam hornbill', 'austen brown hornbill']
    };

    for (const [key, species] of Object.entries(this.speciesData)) {
      const names = [
        species.commonName.toLowerCase(),
        species.scientificName.toLowerCase(),
        ...(species.commonName.split('/').map(s => s.trim().toLowerCase())),
        ...(species.commonName.split(',').map(s => s.trim().toLowerCase()))
      ];

      // Add aliases if available
      const aliasKey = species.commonName.toLowerCase().split('/')[0].trim().replace(/[^a-z\s]/g, '');
      if (speciesAliases[aliasKey]) {
        names.push(...speciesAliases[aliasKey]);
      }

      // Also add first word of common name as alias
      const firstWord = species.commonName.split(' ')[0].toLowerCase();
      if (firstWord.length > 3) {
        names.push(firstWord);
      }

      for (const name of names) {
        if (name.length > 2 && text.includes(name)) {
          found.push({
            key,
            commonName: species.commonName,
            scientificName: species.scientificName,
            schedule: species.schedule,
            category: species.category,
            protectionLevel: species.schedule === 'I' ? 'highest' :
                           species.schedule === 'II' ? 'high' :
                           species.schedule === 'III' ? 'moderate' : 'CITES'
          });
          break; // Avoid duplicates
        }
      }
    }

    return found;
  }

  /**
   * Extract context clues (location, activity, etc.).
   */
  _extractContext(text) {
    const context = {
      location: null,
      activity: null,
      protectedArea: false,
      humanInvolvement: false,
      commercialActivity: false,
      timeOfDay: null
    };

    // Location indicators
    const locationKeywords = {
      'village': 'village',
      'farm': 'agricultural land',
      'field': 'agricultural land',
      'forest': 'forest',
      'sanctuary': 'sanctuary',
      'national park': 'national park',
      'tiger reserve': 'tiger reserve',
      'reserve': 'protected area',
      'beach': 'coastal/marine',
      'river': 'riverine',
      'lake': 'wetland',
      'wetland': 'wetland',
      'grassland': 'grassland',
      'urban': 'urban',
      'city': 'urban',
      'town': 'urban'
    };

    for (const [keyword, locType] of Object.entries(locationKeywords)) {
      if (text.includes(keyword)) {
        context.location = locType;
        if (['sanctuary', 'national park', 'tiger reserve', 'protected area'].includes(keyword)) {
          context.protectedArea = true;
        }
        break;
      }
    }

    // Activity indicators
    if (text.includes('nest') || text.includes('breeding') || text.includes('eggs') || text.includes('chick')) {
      context.activity = 'breeding/nesting';
    } else if (text.includes('crop') || text.includes('agriculture') || text.includes('farming')) {
      context.activity = 'agriculture';
    } else if (text.includes('graze') || text.includes('livestock') || text.includes('cattle') || text.includes('goat')) {
      context.activity = 'grazing';
    } else if (text.includes('tourist') || text.includes('safari') || text.includes('visit')) {
      context.activity = 'tourism';
    } else if (text.includes('research') || text.includes('study') || text.includes('survey')) {
      context.activity = 'research';
    } else if (text.includes('poach') || text.includes('hunt') || text.includes('trap') || text.includes('snare')) {
      context.activity = 'poaching';
    } else if (text.includes('trade') || text.includes('sell') || text.includes('buy') || text.includes('smuggl')) {
      context.activity = 'illegal trade';
      context.commercialActivity = true;
    }

    // Human involvement
    if (text.includes('children') || text.includes('villager') || text.includes('people') ||
        text.includes('person') || text.includes('man') || text.includes('woman')) {
      context.humanInvolvement = true;
    }

    return context;
  }

  /**
   * Determine applicable WLPA sections based on incident.
   */
  _determineApplicableSections(incidentType, species, context) {
    const sections = new Set();
    const scheduleSet = new Set();

    // From incident patterns
    if (this.patterns && this.patterns[incidentType]) {
      const pattern = this.patterns[incidentType];
      if (pattern.applicableSections) {
        if (pattern.applicableSections.immediate) {
          pattern.applicableSections.immediate.forEach(s => sections.add(s.split(' - ')[0]));
        }
        if (pattern.applicableSections.investigation) {
          pattern.applicableSections.investigation.forEach(s => sections.add(s.split(' - ')[0]));
        }
        if (pattern.applicableSections.procedure) {
          pattern.applicableSections.procedure.forEach(s => sections.add(s.split(' - ')[0]));
        }
      }
    }

    // From species schedules
    for (const sp of species) {
      scheduleSet.add(sp.schedule);
      if (sp.schedule === 'I' || sp.schedule === 'II') {
        sections.add('Section 9');  // Hunting prohibition
        sections.add('Section 39'); // Government property
        sections.add('Section 51'); // Penalties
      }
      if (sp.schedule === 'IV') {
        sections.add('Section 49M'); // CITES possession
        sections.add('Section 49H'); // CITES trade
      }
    }

    // Context-specific
    if (context.protectedArea) {
      sections.add('Section 29'); // Sanctuary protection
      sections.add('Section 35'); // National Park protection
    }
    if (context.activity === 'grazing') {
      sections.add('Section 33'); // Sanctuary grazing rules
    }
    if (context.activity === 'illegal trade') {
      sections.add('Section 44'); // Trade licence
      sections.add('Section 48A'); // Transport restriction
      sections.add('Section 39'); // Government property
    }

    // Incident type specific sections (fallback when pattern not loaded)
    if (incidentType === 'human_wildlife_conflict') {
      sections.add('Section 9');   // Hunting prohibition
      sections.add('Section 11');  // Hunting permit for dangerous animals
      sections.add('Section 39');  // Government property
      sections.add('Section 51');  // Penalties
      sections.add('Section 60B'); // Reward for assistance
    }
    if (incidentType === 'nest_disturbance') {
      sections.add('Section 9');   // Hunting includes nest/egg disturbance
      sections.add('Section 39');  // Government property
      sections.add('Section 51');  // Penalties
      sections.add('Section 29');  // Sanctuary protection (if in protected area)
    }
    if (incidentType === 'animal_attack') {
      sections.add('Section 9');   // Hunting prohibition
      sections.add('Section 11');  // Permit to hunt dangerous animal
      sections.add('Section 39');  // Government property
      sections.add('Section 51');  // Penalties
    }

    return Array.from(sections).sort();
  }

  /**
   * Determine possible offences.
   */
  _determineOffences(incidentType, species, context) {
    const offences = [];

    if (this.patterns && this.patterns[incidentType]) {
      const pattern = this.patterns[incidentType];
      if (pattern.offencesIfPoaching) {
        offences.push(...pattern.offencesIfPoaching);
      }
    }

    // Add based on species
    for (const sp of species) {
      if (sp.schedule === 'I' || sp.schedule === 'II') {
        offences.push('Section 9 - Hunting prohibition (Schedule I/II)');
        offences.push('Section 51 - Enhanced penalties for Schedule I/II');
      }
    }

    // Context-based
    if (context.protectedArea && context.activity === 'poaching') {
      offences.push('Section 51C - Tiger reserve core area penalties (if applicable)');
    }

    return [...new Set(offences)];
  }

  /**
   * Generate practical steps for the user.
   */
  _generatePracticalSteps(incidentType, species, context, language) {
    const steps = [];

    if (this.patterns && this.patterns[incidentType]) {
      steps.push(...(this.patterns[incidentType].practicalSteps || []));
    }

    // Add species-specific steps
    for (const sp of species) {
      if (sp.schedule === 'I') {
        steps.push(`IMMEDIATE: Contact Forest Department - ${sp.commonName} is Schedule I (highest protection)`);
      }
    }

    // Context-specific additions
    if (context.protectedArea) {
      steps.push('You are in a protected area - all wildlife offences carry enhanced penalties');
    }
    if (context.activity === 'breeding/nesting') {
      steps.push('Breeding season disturbance is a serious offence - do not approach nests');
    }
    if (context.humanInvolvement && incidentType === 'human_wildlife_conflict') {
      steps.push('Ensure human safety first - do not approach or provoke the animal');
    }

    // Language-specific guidance
    if (language === 'hi') {
      steps.push('वन विभाग से तुरंत संपर्क करें: 1926 (टोल फ्री) या निकटतम वन कार्यालय');
    } else if (language === 'mr') {
      steps.push('वन विभागात त्वरित संपर्क करा: 1926 (टोल फ्री) किंवा जवळील वन कार्यालय');
    } else {
      steps.push('Contact Forest Department immediately: 1926 (toll-free) or nearest forest office');
    }

    return [...new Set(steps)]; // Deduplicate
  }

  /**
   * Determine if Forest Department contact is needed.
   */
  _needsForestDepartment(incidentType, species, context) {
    // Always for Schedule I species
    for (const sp of species) {
      if (sp.schedule === 'I') return true;
    }

    // For poaching, dead animal, illegal trade
    if (['poaching', 'dead_animal', 'illegal_trade', 'illegal_possession'].includes(incidentType)) {
      return true;
    }

    // For nest disturbance - always needs forest dept (breeding site protection)
    if (incidentType === 'nest_disturbance') {
      return true;
    }

    // For plant destruction
    if (incidentType === 'plant_destruction') {
      return true;
    }

    // For human-wildlife conflict with injury/death
    if (incidentType === 'human_wildlife_conflict' && context.humanInvolvement) {
      return true;
    }

    // For protected area violations
    if (context.protectedArea && ['nest_disturbance', 'plant_destruction'].includes(incidentType)) {
      return true;
    }

    return false;
  }

  /**
   * Assess severity level.
   */
  _assessSeverity(incidentType, species, context) {
    let severity = 'low';

    // Schedule I species = critical
    for (const sp of species) {
      if (sp.schedule === 'I') return 'critical';
      if (sp.schedule === 'II') severity = 'high';
    }

    // Incident type severity
    const criticalTypes = ['poaching', 'dead_animal', 'illegal_trade'];
    const highTypes = ['human_wildlife_conflict', 'illegal_possession', 'nest_disturbance'];
    const mediumTypes = ['plant_destruction'];

    if (criticalTypes.includes(incidentType)) return 'critical';
    if (highTypes.includes(incidentType)) return severity === 'high' ? 'high' : 'high';
    if (mediumTypes.includes(incidentType)) return severity === 'low' ? 'medium' : severity;

    // Protected area increases severity
    if (context.protectedArea) {
      if (severity === 'low') return 'medium';
      if (severity === 'medium') return 'high';
    }

    return severity;
  }

  /**
   * Calculate confidence in analysis.
   */
  _calculateConfidence(incidentType, species, context) {
    let confidence = 0.3; // Base

    if (incidentType !== 'unknown') confidence += 0.3;
    if (species.length > 0) confidence += 0.2;
    if (context.location) confidence += 0.1;
    if (context.activity) confidence += 0.1;

    return Math.min(confidence, 1.0);
  }

  /**
   * Format analysis as human-readable response.
   */
  formatResponse(analysis, language = 'en') {
    const { incidentType, species, applicableSections, offences, practicalSteps, needsForestDept, severity } = analysis;

    let response = '';

    // Header
    const headers = {
      en: '🔍 **Scenario Analysis**',
      hi: '🔍 **स्थिति विश्लेषण**',
      mr: '🔍 **परिस्थिति विश्लेषण**'
    };
    response += headers[language] || headers.en;
    response += '\n\n';

    // Incident type
    const typeLabels = {
      en: 'Incident Type',
      hi: 'घटना का प्रकार',
      mr: 'घटना प्रकार'
    };
    response += `**${typeLabels[language] || typeLabels.en}:** ${incidentType.replace('_', ' ').toUpperCase()}\n`;

    // Species
    if (species.length > 0) {
      const speciesLabels = {
        en: 'Species Involved',
        hi: 'संबंधित प्रजातियाँ',
        mr: 'संबंधित प्रजाती'
      };
      response += `**${speciesLabels[language] || speciesLabels.en}:**\n`;
      for (const sp of species) {
        response += `- ${sp.commonName} (${sp.scientificName}) — Schedule ${sp.schedule} [${sp.protectionLevel} protection]\n`;
      }
    }

    // Applicable sections
    if (applicableSections.length > 0) {
      const sectionLabels = {
        en: 'Applicable WLPA Sections',
        hi: 'लागू WLPA धाराएँ',
        mr: 'लागू WLPA कलमे'
      };
      response += `\n**${sectionLabels[language] || sectionLabels.en}:**\n`;
      for (const sec of applicableSections) {
        const secInfo = this.sectionsData?.[sec];
        if (secInfo) {
          response += `- ${sec}: ${secInfo.title}\n`;
        } else {
          response += `- ${sec}\n`;
        }
      }
    }

    // Possible offences
    if (offences.length > 0) {
      const offenceLabels = {
        en: 'Possible Offences',
        hi: 'संभावित अपराध',
        mr: 'संभाव्य गुन्हे'
      };
      response += `\n**${offenceLabels[language] || offenceLabels.en}:**\n`;
      for (const off of offences) {
        response += `- ${off}\n`;
      }
    }

    // Practical steps
    const stepLabels = {
      en: '🛡️ Recommended Steps',
      hi: '🛡️ अनुशंसित कदम',
      mr: '🛡️ शिफारस केलेले पावले'
    };
    response += `\n**${stepLabels[language] || stepLabels.en}:**\n`;
    for (let i = 0; i < practicalSteps.length; i++) {
      response += `${i + 1}. ${practicalSteps[i]}\n`;
    }

    // Forest Department recommendation
    if (needsForestDept) {
      const fdLabels = {
        en: '⚠️ **Contact Forest Department Immediately** — This situation requires official intervention.',
        hi: '⚠️ **तुरंत वन विभाग से संपर्क करें** — इस स्थिति में आधिकारिक हस्तक्षेप आवश्यक है।',
        mr: '⚠️ **लवकरात लवकर वन विभागात संपर्क करा** — या परिस्थितीत अधिकृत हस्तक्षेप आवश्यक आहे।'
      };
      response += `\n${fdLabels[language] || fdLabels.en}\n`;
    }

    // Severity
    const sevLabels = {
      en: { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' },
      hi: { critical: 'अत्यंत गंभीर', high: 'गंभीर', medium: 'मध्यम', low: 'कम' },
      mr: { critical: 'अत्यंत गंभीर', high: 'गंभीर', medium: 'मध्यम', low: 'कम' }
    };
    const sev = sevLabels[language]?.[severity] || sevLabels.en[severity];
    response += `\n**Severity: ${sev}**`;

    return response;
  }
}

module.exports = new ScenarioUnderstandingService();