// Ícone de cada alimento, escolhido pelo nome.
// Produtos e receitas novos ganham ícone sozinhos: basta o nome conter uma das
// palavras abaixo. Imagens em assets/food (Fluent Emoji, licença MIT).

import { normalize } from './util.js';

// Expressões de mais de uma palavra vêm antes: "biscoito de arroz" não é
// biscoito comum, "doce de leite" não é leite.
const PHRASES = [
  ['rice-cracker', ['biscoito de arroz', 'bolacha de arroz']],
  ['coffee', ['chocolate quente', 'cafe com leite']],
  ['custard', ['doce de leite', 'leite condensado', 'arroz doce']],
  ['cheese', ['cream cheese', 'pao de queijo']],
  ['sweet-potato', ['batata doce', 'batata baroa']],
  ['beans', ['grao de bico']],
  ['peanuts', ['pasta de amendoim']],
  ['poultry', ['peito de peru']],
  ['tomato', ['molho de tomate', 'extrato de tomate']],
  ['broccoli', ['couve flor']],
];

// Palavras soltas: vale a primeira palavra do nome que tiver ícone
// ("Tapioca com goiabada" → tapioca). Um "$" no fim exige a palavra inteira
// ("mel" não pode pegar "melancia").
const WORDS = [
  ['bread', ['pao', 'paes', 'torrada', 'bisnaga', 'brioche', 'broa']],
  ['baguette', ['baguete', 'palito', 'grissini', 'ciabatta']],
  ['croissant', ['croissant']],
  ['flatbread', ['tapioca', 'crepioca', 'beiju', 'pita', 'rap10', 'sirio']],
  ['pancakes', ['panqueca', 'crepe']],
  ['waffle', ['waffle']],
  ['cookie', ['biscoito', 'bolacha', 'cookie', 'cracker', 'wafer']],
  ['cake', ['bolo', 'cupcake', 'muffin']],
  ['pie', ['torta', 'empada', 'quiche', 'pastel']],
  ['doughnut', ['rosquinha', 'donut', 'sonho$']],
  ['chocolate', ['chocolate', 'cacau', 'brigadeiro', 'bombom', 'nutella', 'achocolatado']],
  ['custard', ['pudim', 'flan', 'mousse']],
  ['candy', ['bala$', 'balas$', 'doce$', 'doces$', 'jujuba', 'goma', 'pirulito']],
  ['honey', ['mel$', 'geleia', 'goiabada', 'marmelada', 'compota', 'melado', 'rapadura', 'acucar', 'adocante']],
  ['icecream', ['sorvete', 'picole', 'gelato', 'acai']],
  ['coffee', ['cafe$', 'cappuccino', 'capuccino', 'expresso', 'espresso']],
  ['tea', ['cha$', 'mate$', 'camomila', 'infusao']],
  ['cheese', ['queijo', 'ricota', 'requeijao', 'mucarela', 'mussarela', 'parmesao', 'provolone', 'cottage', 'catupiry', 'burrata', 'coalho']],
  ['cereal', ['granola', 'aveia', 'cereal', 'musli', 'muesli', 'iogurte', 'mingau', 'chia', 'linhaca']],
  ['milk', ['leite', 'whey', 'kefir', 'bebida', 'vitamina']],
  ['butter', ['manteiga', 'margarina']],
  ['egg', ['ovo', 'ovos', 'omelete', 'gema', 'clara$']],
  ['poultry', ['frango', 'galinha', 'peru$', 'chester', 'coxa', 'sobrecoxa', 'nugget', 'coxinha']],
  ['bacon', ['bacon', 'toucinho', 'torresmo']],
  ['meat', ['carne', 'bife', 'patinho', 'alcatra', 'picanha', 'acem', 'maminha', 'costela', 'cupim', 'musculo', 'fraldinha', 'contrafile', 'linguica', 'salsicha', 'presunto', 'mortadela', 'salame', 'lombo', 'porco', 'suino', 'pernil', 'bisteca', 'cordeiro', 'kibe', 'quibe']],
  ['fish', ['peixe', 'tilapia', 'salmao', 'atum', 'sardinha', 'bacalhau', 'merluza', 'pescada', 'truta', 'cacao']],
  ['shrimp', ['camarao', 'lagosta', 'marisco', 'lula', 'polvo']],
  ['sushi', ['sushi', 'sashimi', 'temaki']],
  ['canned', ['enlatado', 'conserva', 'lata$']],
  ['rice', ['arroz', 'risoto']],
  ['beans', ['feijao', 'feijoada', 'lentilha', 'ervilha', 'soja', 'tofu']],
  ['sweet-potato', ['mandioca', 'aipim', 'macaxeira', 'inhame', 'cara$', 'mandioquinha']],
  ['potato', ['batata', 'pure$', 'fritas$']],
  ['popcorn', ['pipoca']],
  ['corn', ['milho', 'cuscuz', 'polenta', 'fuba', 'canjica', 'pamonha', 'curau']],
  ['grain', ['quinoa', 'trigo', 'farinha', 'farofa', 'centeio', 'cevada']],
  ['pasta', ['macarrao', 'espaguete', 'massa$', 'lasanha', 'nhoque', 'talharim', 'penne', 'miojo', 'lamen']],
  ['pizza', ['pizza', 'esfiha', 'esfirra']],
  ['burger', ['hamburguer', 'hamburger', 'burger']],
  ['sandwich', ['sanduiche', 'misto$', 'bauru', 'beirute', 'lanche']],
  ['taco', ['taco', 'nacho']],
  ['burrito', ['burrito', 'wrap']],
  ['pot', ['sopa', 'caldo', 'ensopado', 'estrogonofe', 'strogonoff', 'moqueca', 'escondidinho', 'guisado', 'cozido']],
  ['salad', ['salada']],
  ['greens', ['alface', 'rucula', 'couve', 'espinafre', 'agriao', 'repolho', 'acelga', 'verdura']],
  ['broccoli', ['brocolis']],
  ['tomato', ['tomate']],
  ['carrot', ['cenoura', 'beterraba']],
  ['onion', ['cebola']],
  ['garlic', ['alho$']],
  ['pepper', ['pimentao', 'pimenta']],
  ['cucumber', ['pepino', 'abobrinha', 'chuchu']],
  ['mushroom', ['cogumelo', 'champignon', 'shimeji', 'shitake']],
  ['avocado', ['abacate', 'guacamole']],
  ['banana', ['banana']],
  ['apple', ['maca$', 'macas$', 'goiaba', 'caju', 'fruta', 'frutas$']],
  ['pear', ['pera$', 'peras$']],
  ['peach', ['pessego', 'nectarina', 'damasco']],
  ['orange', ['laranja', 'tangerina', 'mexerica', 'bergamota', 'ponkan', 'maracuja']],
  ['lemon', ['limao', 'lima$']],
  ['grapes', ['uva', 'uvas$', 'passa$', 'passas$']],
  ['strawberry', ['morango']],
  ['watermelon', ['melancia', 'melao']],
  ['pineapple', ['abacaxi']],
  ['mango', ['manga$', 'mamao', 'papaia']],
  ['kiwi', ['kiwi']],
  ['cherries', ['cereja', 'acerola', 'pitanga']],
  ['blueberries', ['mirtilo', 'amora', 'framboesa', 'jabuticaba']],
  ['coconut', ['coco$', 'cocada']],
  ['peanuts', ['amendoim', 'pacoca']],
  ['nuts', ['castanha', 'nozes', 'noz$', 'amendoa', 'macadamia', 'pistache', 'avela']],
  ['olive', ['azeite', 'azeitona', 'oleo']],
  ['salt', ['sal$', 'tempero']],
  ['juice', ['suco', 'nectar']],
  ['soda', ['refrigerante', 'coca$', 'guarana', 'energetico', 'isotonico']],
  ['water', ['agua']],
  ['wine', ['vinho', 'espumante']],
  ['beer', ['cerveja', 'chopp', 'chope']],
];

const RULES = WORDS.flatMap(([icon, words]) => words.map((w) => (
  w.endsWith('$') ? { icon, word: w.slice(0, -1), exact: true } : { icon, word: w, exact: false }
)));

const cache = new Map();

/** Ícone pelo nome, ou null se nenhuma palavra for reconhecida. */
export function iconForName(name) {
  const key = normalize(name);
  if (cache.has(key)) return cache.get(key);
  let found = null;
  for (const [icon, phrases] of PHRASES) {
    if (phrases.some((p) => key.includes(p))) {
      found = icon;
      break;
    }
  }
  if (!found) {
    for (const token of key.split(/[^a-z0-9]+/).filter(Boolean)) {
      const rule = RULES.find((r) => (r.exact ? token === r.word : token.startsWith(r.word)));
      if (rule) {
        found = rule.icon;
        break;
      }
    }
  }
  cache.set(key, found);
  return found;
}

/** Produto sem palavra conhecida vira um pote da despensa. */
export function productIcon(product) {
  return iconForName(product?.nome || '') || 'jar';
}

/**
 * Receita: primeiro pelo nome ("Chocolate quente"); se o nome não diz nada
 * ("Romeu e Julieta"), usa o ingrediente com mais calorias.
 */
export function recipeIcon(recipe) {
  const byName = iconForName(recipe?.nome || '');
  if (byName) return byName;
  const main = [...(recipe?.items || [])]
    .sort((a, b) => ((b.nutr?.kcal || 0) * b.qty) - ((a.nutr?.kcal || 0) * a.qty))[0];
  return main ? productIcon(main) : 'plate';
}

export const SLOT_ICONS = { cafe: 'coffee', almoco: 'plate', lanche: 'sandwich', jantar: 'bowl' };

export const foodSrc = (icon) => `assets/food/${icon}.webp`;

export function foodImg(icon, size = 40, cls = '') {
  return `<img class="food ${cls}" src="${foodSrc(icon)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
}
