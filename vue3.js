var Vue = (function (exports) {
	'use strict';

	/**
	 * Vue平台工具方法
	 ***************************************************************/

	/**
	 * 将字符串转成对象
	 * @param {String} str 字符串
	 * @param {Boolean} expectsLowerCase 是否转成小写
	 * e.g. 
	 * str = 'div,p'
	 * @returns
	 * { div: true, p: true }
	 */
	function makeMap(str, expectsLowerCase) {
		const map = Object.create(null);
		const list = str.split(',');
		for (let i = 0; i < list.length; i++) {
			map[list[i]] = true;
		}
		return expectsLowerCase ? val => !!map[val.toLowerCase()] : val => !!map[val];
	}

	// 补丁标志是编译器生成的优化提示。
	// 当在diff过程中遇到带有动态子节点时，算法进入“优化模式”
	// 在这种模式下，我们知道虚拟DOM节点是由render函数编译生成的
	// 所以算法只需要处理这些由补丁标志显示标志的节点更新。
	const PatchFlagNames = {
		[1 /* TEXT */]: `TEXT`,
		[2 /* CLASS */]: `CLASS`,
		[4 /* STYLE */]: `STYLE`,
		[8 /* PROPS */]: `PROPS`,
		[16 /* FULL_PROPS */]: `FULL_PROPS`,
		[32 /* HYDRATE_EVENTS */]: `HYDRATE_EVENTS`,
		[64 /* STABLE_FRAGMENT */]: `STABLE_FRAGMENT`,
		[128 /* KEYED_FRAGMENT */]: `KEYED_FRAGMENT`,
		[256 /* UNKEYED_FRAGMENT */]: `UNKEYED_FRAGMENT`,
		[1024 /* DYNAMIC_SLOTS */]: `DYNAMIC_SLOTS`,
		[512 /* NEED_PATCH */]: `NEED_PATCH`,
		[-1 /* HOISTED */]: `HOISTED`,
		[-2 /* BAIL */]: `BAIL`
	};

	const GLOBALS_WHITE_LISTED = 'Infinity,undefined,NaN,isFinite,isNaN,parseFloat,parseInt,decodeURI,' +
		'decodeURIComponent,encodeURI,encodeURIComponent,Math,Number,Date,Array,' +
		'Object,Boolean,String,RegExp,Map,Set,JSON,Intl';
	// 标记JavaScript自带的全局方法
	const isGloballyWhitelisted = /*#__PURE__ 该标志表示这个方法在编译时会被tree-shaking掉*/ makeMap(GLOBALS_WHITE_LISTED);

	/**
	 * 生成错误代码提示
	 * e.g. 
	 * source（报错htmml） => '\n    <div :class="{name: true, age: true">{{list[0].name}}</div>\n  '
	 * start（开始位置） => 18
	 * end（结束位置） => 40 (default:source.length)
	 */
	const range = 2;
	function generateCodeFrame(source, start = 0, end = source.length) {
		// lines => ['', '    <div :class="{name: true, age: true">{{list[0].name}}</div>', '  ']
		const lines = source.split(/\r?\n/);
		let count = 0;
		const res = [];
		for (let i = 0; i < lines.length; i++) {
			count += lines[i].length + 1;
			// count >= start意味着已进入报错html位置
			if (count >= start) {
				// end > count意味着还在报错html内
				for (let j = i - range; j <= i + range || end > count; j++) {
					if (j < 0 || j >= lines.length)
						continue;
					// line => 当前所在行
					const line = j + 1;
					res.push(`${line}${' '.repeat(Math.max(3 - String(line).length, 0))}|  ${lines[j]}`);
					const lineLength = lines[j].length;
					if (j === i) {
						// pad => 未报错的html长度
						const pad = start - (count - lineLength) + 1;
						const length = Math.max(1, end > count ? lineLength - pad : end - start);
						// 添加                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
						res.push(`   |  ` + ' '.repeat(pad) + '^'.repeat(length));
					}
					else if (j > i) {
						if (end > count) {
							const length = Math.max(Math.min(end - count, lineLength), 1);
							res.push(`   |  ` + '^'.repeat(length));
						}
						count += lineLength + 1;
					}
				}
				break;
			}
		}
		return res.join('\n');
	}

	/**
	 * 在客户端上，我们只需要为布尔属性提供特殊情况，这些属性的名称与其相应的dom属性不同
	 * - itemscope -> N/A
	 * - allowfullscreen -> allowFullscreen
	 * - formnovalidate -> formNoValidate
	 * - ismap -> isMap
	 * - nomodule -> noModule
	 * - novalidate -> noValidate
	 * - readonly -> readOnly
	 */
	const specialBooleanAttrs = `itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly`;
	const isSpecialBooleanAttr = /*#__PURE__*/ makeMap(specialBooleanAttrs);

	/**
	 * 格式化style
	 * @param {Object|Array} value 
	 */
	function normalizeStyle(value) {
		if (isArray(value)) {
			const res = {};
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				const normalized = normalizeStyle(isString(item) ? parseStringStyle(item) : item);
				if (normalized) {
					for (const key in normalized) {
						res[key] = normalized[key];
					}
				}
			}
			return res;
		}
		else if (isObject(value)) {
			return value;
		}
	}

	// 匹配每一项样式 从 `;`号开始，`)`号结束
	// e.g. background: rgb(112, 213, 32);
	const listDelimiterRE = /;(?![^(]*\))/g;

	// 匹配属性名和属性值 从 `:`号开始
	// e.g. "width:50px" => ["width", "50px", ""]
	const propertyDelimiterRE = /:(.+)/;

	/**
	 * 处理字符串样式
	 * @param {String} cssText 
	 * @returns 返回style对象
	 */
	function parseStringStyle(cssText) {
		const ret = {};
		cssText.split(listDelimiterRE).forEach(item => {
			if (item) {
				const tmp = item.split(propertyDelimiterRE);
				tmp.length > 1 && (ret[tmp[0].trim()] = tmp[1].trim());
			}
		});
		return ret;
	}

	/**
	 * 格式化class
	 * @param {String|Array|Object} value 
	 */
	function normalizeClass(value) {
		let res = '';
		if (isString(value)) {
			res = value;
		}
		else if (isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				res += normalizeClass(value[i]) + ' ';
			}
		}
		else if (isObject(value)) {
			for (const name in value) {
				if (value[name]) {
					res += name + ' ';
				}
			}
		}
		return res.trim();
	}

	// HTML自带的标签
	const HTML_TAGS = 'html,body,base,head,link,meta,style,title,address,article,aside,footer,' +
		'header,h1,h2,h3,h4,h5,h6,hgroup,nav,section,div,dd,dl,dt,figcaption,' +
		'figure,picture,hr,img,li,main,ol,p,pre,ul,a,b,abbr,bdi,bdo,br,cite,code,' +
		'data,dfn,em,i,kbd,mark,q,rp,rt,rtc,ruby,s,samp,small,span,strong,sub,sup,' +
		'time,u,var,wbr,area,audio,map,track,video,embed,object,param,source,' +
		'canvas,script,noscript,del,ins,caption,col,colgroup,table,thead,tbody,td,' +
		'th,tr,button,datalist,fieldset,form,input,label,legend,meter,optgroup,' +
		'option,output,progress,select,textarea,details,dialog,menu,' +
		'summary,template,blockquote,iframe,tfoot';
	// SVG自带的标签
	const SVG_TAGS = 'svg,animate,animateMotion,animateTransform,circle,clipPath,color-profile,' +
		'defs,desc,discard,ellipse,feBlend,feColorMatrix,feComponentTransfer,' +
		'feComposite,feConvolveMatrix,feDiffuseLighting,feDisplacementMap,' +
		'feDistanceLight,feDropShadow,feFlood,feFuncA,feFuncB,feFuncG,feFuncR,' +
		'feGaussianBlur,feImage,feMerge,feMergeNode,feMorphology,feOffset,' +
		'fePointLight,feSpecularLighting,feSpotLight,feTile,feTurbulence,filter,' +
		'foreignObject,g,hatch,hatchpath,image,line,linearGradient,marker,mask,' +
		'mesh,meshgradient,meshpatch,meshrow,metadata,mpath,path,pattern,' +
		'polygon,polyline,radialGradient,rect,set,solidcolor,stop,switch,symbol,' +
		'text,textPath,title,tspan,unknown,use,view';
	const VOID_TAGS = 'area,base,br,col,embed,hr,img,input,link,meta,param,source,track,wbr';
	const isHTMLTag = /*#__PURE__*/ makeMap(HTML_TAGS);
	const isSVGTag = /*#__PURE__*/ makeMap(SVG_TAGS);

	// 判断标签是否为单标签
	const isVoidTag = /*#__PURE__*/ makeMap(VOID_TAGS);

	// 模糊校验传入的两个参数是否相等
	function looseCompareArrays(a, b) {
		if (a.length !== b.length)
			return false;
		let equal = true;
		for (let i = 0; equal && i < a.length; i++) {
			equal = looseEqual(a[i], b[i]);
		}
		return equal;
	}
	function looseEqual(a, b) {
		if (a === b)
			return true;
		let aValidType = isDate(a);
		let bValidType = isDate(b);
		if (aValidType || bValidType) {
			return aValidType && bValidType ? a.getTime() === b.getTime() : false;
		}
		aValidType = isArray(a);
		bValidType = isArray(b);
		if (aValidType || bValidType) {
			return aValidType && bValidType ? looseCompareArrays(a, b) : false;
		}
		aValidType = isObject(a);
		bValidType = isObject(b);
		if (aValidType || bValidType) {
			if (!aValidType || !bValidType) {
				return false;
			}
			const aKeysCount = Object.keys(a).length;
			const bKeysCount = Object.keys(b).length;
			// 通过属性长度来判断
			if (aKeysCount !== bKeysCount) {
				return false;
			}
			for (const key in a) {
				const aHasKey = a.hasOwnProperty(key);
				const bHasKey = b.hasOwnProperty(key);
				if ((aHasKey && !bHasKey) ||
					(!aHasKey && bHasKey) ||
					!looseEqual(a[key], b[key])) {
					return false;
				}
			}
		}
		return String(a) === String(b);
	}

	// 模糊查找
	// 查找val值在arr数组中的下标
	function looseIndexOf(arr, val) {
		return arr.findIndex(item => looseEqual(item, val));
	}

	/**
	 * 将value值转换成字符串
	 * @private
	 */
	const toDisplayString = (val) => {
		return val == null
			? ''
			: isObject(val)
				// JSON.stringify接收三个参数
				// val => 将要序列化成一个JSON字符串的值
				// replacer => 可选。
				//  如果该参数是一个函数，则在序列化过程中，被序列化的值每个属性都会
				//  经过该函数的转换和处理：如果该参数是一个数组，则只有包含在这个数组中的属性名才会被序列化到
				//  最终的JSON字符串中：如果该参数为null或者为提供，则对象所有的属性都会被序列化。
				// space => 可选。
				//  指定缩进用的空白字符串，用于美化输出
				//  如果参数是个数字，它代表有多少个空格：上限为10。该值若小于1，则意味着没有空格。
				//  如果该参数为字符串（字符串的前十个字母），该字符串被作为空格：如果该参数没有提供（或者为null）将没有空格。

				// 如果设置replacer转换器，Set和Map将会被转换成空对象`{}`
				? JSON.stringify(val, replacer, 2)
				: String(val);
	};
	// 转换器
	const replacer = (_key, val) => {
		if (isMap(val)) {
			return {
				// e.g.
				// let val = new Map([ ["name", "fanqiewa"], ["age", "age"] ]);
				// [...val.entries()] => [ ["name", "fanqiewa"], ["age", "age"] ]
				/*
					{
						"Map(2)": {
							"name =>": "fanqiewa",
							"age =>": "age"
						}
					}
				*/
				[`Map(${val.size})`]: [...val.entries()].reduce((entries, [key, val] /* 每一项都为一个数组，解构该数组 */) => {
					entries[`${key} =>`] = val;
					return entries;
				}, {})
			};
		}
		else if (isSet(val)) {
			return {
				// e.g. 
				// let val = new Set(["red", "yello", "green"]);
				// [...val.values()] => [ 'red', 'yello', 'green' ]
				/*
					"Set(3)": [
						"red",
						"yello",
						"green"
					]
				*/
				[`Set(${val.size})`]: [...val.values()]
			};
		}
		else if (isObject(val) && !isArray(val) && !isPlainObject(val)) {
			// e.g. 
			// let val = new RegExp(/\d/g);
			// return "/\\d/g"
			return String(val);
		}
		return val;
	};

	// 空对象
	const EMPTY_OBJ = Object.freeze({});
	// 空数组
	const EMPTY_ARR = Object.freeze([]);
	// 空函数
	const NOOP = () => { };
	/**
	 * 调用否函数，返回false
	 */
	const NO = () => false;
	const onRE = /^on[^a-z]/;
	// 判断key是否以on开头
	const isOn = (key) => onRE.test(key);
	// 判断key是否为v-model事件监听
	const isModelListener = (key) => key.startsWith('onUpdate:');
	const extend = Object.assign;
	// 从数组中移除匹配项
	const remove = (arr, el) => {
		const i = arr.indexOf(el);
		if (i > -1) {
			arr.splice(i, 1);
		}
	};
	const hasOwnProperty = Object.prototype.hasOwnProperty;
	const hasOwn = (val, key) => hasOwnProperty.call(val, key);
	const isArray = Array.isArray;
	const isMap = (val) => toTypeString(val) === '[object Map]';
	const isSet = (val) => toTypeString(val) === '[object Set]';
	const isDate = (val) => val instanceof Date;
	const isFunction = (val) => typeof val === 'function';
	const isString = (val) => typeof val === 'string';
	const isSymbol = (val) => typeof val === 'symbol';
	const isObject = (val) => val !== null && typeof val === 'object';
	const isPromise = (val) => {
		return isObject(val) && isFunction(val.then) && isFunction(val.catch);
	};
	const objectToString = Object.prototype.toString;
	const toTypeString = (value) => objectToString.call(value);

	// 获取传入参数的最原始类型（字符串）
	const toRawType = (value) => {
		// toString => "[object RawType]"
		// .slice => RawType
		// e.g. return "Object"
		return toTypeString(value).slice(8, -1);
	};
	const isPlainObject = (val) => toTypeString(val) === '[object Object]';
	// 判断key是否为正整数
	const isIntegerKey = (key) => isString(key) &&
		key !== 'NaN' &&
		key[0] !== '-' &&
		'' + parseInt(key, 10) === key;
	
	// 预留prop
	const isReservedProp = /*#__PURE__*/ makeMap(
		',key,ref,' +
		'onVnodeBeforeMount,onVnodeMounted,' +
		'onVnodeBeforeUpdate,onVnodeUpdated,' +
		'onVnodeBeforeUnmount,onVnodeUnmounted');
	// 字符串缓存构造工厂
	const cacheStringFunction = (fn) => {
		const cache = Object.create(null);
		return ((str) => {
			const hit = cache[str];
			return hit || (cache[str] = fn(str));
		});
	};
	const camelizeRE = /-(\w)/g;
	/**
	 * 将中划线命名转成小驼峰命名
	 * @private
	 */
	const camelize = cacheStringFunction((str) => {
		return str.replace(camelizeRE, (_, c) => (c ? c.toUpperCase() : ''));
	});
	const hyphenateRE = /\B([A-Z])/g;
	/**
	 * 将小驼峰命名改成中划线命名
	 * @private
	 */
	const hyphenate = cacheStringFunction((str) => str.replace(hyphenateRE, '-$1').toLowerCase());
	/**
	 * 将字符串第一个字符转成大写
	 * @private
	 */
	const capitalize = cacheStringFunction((str) => str.charAt(0).toUpperCase() + str.slice(1));
	/**
	 * 将handlerKey添加前缀`on`
	 * @private
	 */
	const toHandlerKey = cacheStringFunction((str) => (str ? `on${capitalize(str)}` : ``));
	// 比较前后两个值是否相等 NaN不等于NaN
	const hasChanged = (value, oldValue) => value !== oldValue && (value === value || oldValue === oldValue);

	/**
	 * invoke是调用的意思
	 * 调用数组中的fn
	 */
	const invokeArrayFns = (fns, arg) => {
		for (let i = 0; i < fns.length; i++) {
			fns[i](arg);
		}
	};
	// 拦截对象，可配置，不可枚举
	const def = (obj, key, value) => {
		Object.defineProperty(obj, key, {
			configurable: true, // 表示该属性能否通过delete删除，能否修改属性的特性或者能否修改访问器属性。默认为false
			enumerable: false, // 表示该属性是否可枚举，即可否通过for..in访问属性。默认为false
			value // 表示该属性的值。默认为undefined
			// writable 表示该属性的值是否可写，默认为false。当且仅当属性的writable为true时，其值才能被赋值运算符改变
		});
	};
	// 将val转成Number类型，如果为NaN，直接返回传入值
	const toNumber = (val) => {
		const n = parseFloat(val);
		return isNaN(n) ? val : n;
	};

	/**
	 * proxy
	 ***************************************************************/

	let _globalThis;
	// 获取全局this
	const getGlobalThis = () => {
		return (_globalThis ||
			(_globalThis =
				typeof globalThis !== 'undefined'
					? globalThis
					: typeof self !== 'undefined'
						? self
						: typeof window !== 'undefined' // 浏览器环境为window
							? window
							: typeof global !== 'undefined' // node环境为global
								? global
								: {}));
	};

	// e.g. 
	// { target: [], ... }
	const targetMap = new WeakMap();
	// effect栈
	const effectStack = [];
	// 当前活跃的effect
	let activeEffect;
	const ITERATE_KEY = Symbol('iterate');
	const MAP_KEY_ITERATE_KEY = Symbol('Map key iterate');
	// 判断传入参数是否为effect类型
	function isEffect(fn) {
		return fn && fn._isEffect === true;
	}
	// 响应式函数
	function effect(fn, options = EMPTY_OBJ) {
		if (isEffect(fn)) {
			fn = fn.raw;
		}
		const effect = createReactiveEffect(fn, options);
		if (!options.lazy) {
			effect();
		}
		return effect;
	}
	// 停止响应
	function stop(effect) {
		if (effect.active) {
			cleanup(effect);
			if (effect.options.onStop) {
				effect.options.onStop();
			}
			effect.active = false;
		}
	}
	let uid = 0;
	// 创建动态响应式函数
	function createReactiveEffect(fn, options) {
		const effect = function reactiveEffect() {
			if (!effect.active) {
				return options.scheduler ? undefined : fn();
			}
			if (!effectStack.includes(effect)) {
				// 先清空deps数组
				cleanup(effect);
				try {
					enableTracking();
					effectStack.push(effect);
					// 暂存当前激活的effect，在dep.add时，会添加到deps数组中
					activeEffect = effect;
					return fn();
				}
				finally {
					effectStack.pop();
					resetTracking();
					// 重置当前激活的effect
					activeEffect = effectStack[effectStack.length - 1];
				}
			}
		};
		effect.id = uid++; // 标志位（第几个创建的响应式函数）
		effect.allowRecurse = !!options.allowRecurse; // 是否允许递归 TODO
		effect._isEffect = true;
		effect.active = true;
		effect.raw = fn; // 暂存原始的函数（没被添加响应式之前的函数）
		effect.deps = [];
		effect.options = options;
		return effect;
	}
	// 清空响应式函数的deps数组
	function cleanup(effect) {
		const { deps } = effect;
		if (deps.length) {
			for (let i = 0; i < deps.length; i++) {
				deps[i].delete(effect);
			}
			deps.length = 0;
		}
	}
	let shouldTrack = true;
	const trackStack = [];
	// 暂停记录轨迹
	function pauseTracking() {
		trackStack.push(shouldTrack);
		shouldTrack = false;
	}
	// 允许记录轨迹
	function enableTracking() {
		trackStack.push(shouldTrack);
		shouldTrack = true;
	}
	// 重置是否允许记录轨迹
	function resetTracking() {
		const last = trackStack.pop();
		shouldTrack = last === undefined ? true : last;
	}
	/**
	 * 添加跟踪依赖
	 * @param {Object|Array} target 目标对象
	 * @param {String} type 跟踪类型
	 * @param {Object|Array} key 如果target为数组，则key为数组中的每一项，如果target为对象，则key为对象的属性
	 */
	function track(target, type, key) {
		// 如果不允许记录轨迹或者当前激活的effect不存在，则终止函数
		if (!shouldTrack || activeEffect === undefined) {
			return;
		}
		let depsMap = targetMap.get(target);
		if (!depsMap) {
			// 将target添加到targetMap对象中
			/**
			 	e.g. 
				targetMap = {
					target // e.g. data对象 : { // depsMap对象
						key // e.g. "messageType": [ // dep集合
							activeEffect() {
								// .deps = [ activeEffect() { } ]
							}
						]
					}
				}
			 */
			targetMap.set(target, (depsMap = new Map()));
		}
		let dep = depsMap.get(key);
		if (!dep) {
			// 将key值添加到depsMap集合中
			depsMap.set(key, (dep = new Set()));
		}
		if (!dep.has(activeEffect)) {
			// activeEffect => fn reactiveEffect()
			// 将dep集合添加到effect的deps中
			dep.add(activeEffect);
			activeEffect.deps.push(dep);
			if (activeEffect.options.onTrack) {
				activeEffect.options.onTrack({
					effect: activeEffect,
					target,
					type,
					key
				});
			}
		}
	}
	/**
	 * 触发响应式函数
	 * @param {Function} target 被拦截的对象或数组（proxy）
	 * @param {String} type 事件类型
	 * @param {String} key 
	 * @param {*} newValue 新值
	 * @param {*} oldValue 旧值
	 * @param {*} oldTarget 旧effect
	 * @returns 
	 */
	function trigger(target, type, key, newValue, oldValue, oldTarget) {
		const depsMap = targetMap.get(target);
		if (!depsMap) {
			// 从来没有添加依赖，则终止函数
			return;
		}
		const effects = new Set();
		const add = (effectsToAdd) => {
			if (effectsToAdd) {
				effectsToAdd.forEach(effect => {
					if (effect !== activeEffect || effect.allowRecurse) {
						effects.add(effect);
					}
				});
			}
		};
		if (type === "clear" /* CLEAR */) {
			// 清除不是删除，而是指触发其他响应式函数的响应
			// 除了当前激活的effect，触发所有响应式函数
			depsMap.forEach(add);
		}
		// TODO
		else if (key === 'length' && isArray(target)) {
			depsMap.forEach((dep, key) => {
				if (key === 'length' || key >= newValue) {
					add(dep);
				}
			});
		}
		else {
			// schedule runs for SET | ADD | DELETE
			if (key !== void 0) {
				add(depsMap.get(key));
			}
			// also run for iteration key on ADD | DELETE | Map.SET
			switch (type) {
				case "add" /* ADD */:
					if (!isArray(target)) {
						add(depsMap.get(ITERATE_KEY));
						if (isMap(target)) {
							add(depsMap.get(MAP_KEY_ITERATE_KEY));
						}
					}
					else if (isIntegerKey(key)) {
						// new index added to array -> length changes
						add(depsMap.get('length'));
					}
					break;
				case "delete" /* DELETE */:
					if (!isArray(target)) {
						add(depsMap.get(ITERATE_KEY));
						if (isMap(target)) {
							add(depsMap.get(MAP_KEY_ITERATE_KEY));
						}
					}
					break;
				case "set" /* SET */:
					if (isMap(target)) {
						add(depsMap.get(ITERATE_KEY));
					}
					break;
			}
		}
		// 运行响应式函数
		const run = (effect) => {
			if (effect.options.onTrigger) {
				effect.options.onTrigger({
					effect,
					target,
					key,
					type,
					newValue,
					oldValue,
					oldTarget
				});
			}
			if (effect.options.scheduler) {
				// 如果调度方法存在，执行调度方法
				effect.options.scheduler(effect);
			}
			else {
				// 否则执行reactiveEffect方法
				effect();
			}
		};
		effects.forEach(run);
	}

	const builtInSymbols = new Set(Object.getOwnPropertyNames(Symbol)
		// Set {
		// 		Symbol(Symbol.asyncIterator),
		// 		Symbol(Symbol.hasInstance),
		// 		Symbol(Symbol.isConcatSpreadable),
		// 		Symbol(Symbol.iterator),
		// 		Symbol(Symbol.match),
		// 		Symbol(Symbol.replace),
		// 		Symbol(Symbol.search),
		// 		Symbol(Symbol.species),
		// 		Symbol(Symbol.split),
		// 		Symbol(Symbol.toPrimitive),
		// 		Symbol(Symbol.toStringTag),
		// 		Symbol(Symbol.unscopables)
		// }
		.map(key => Symbol[key])
		
		// builtInSymbols = Set {
		// 		Symbol(Symbol.asyncIterator),
		// 		Symbol(Symbol.hasInstance),
		// 		Symbol(Symbol.isConcatSpreadable),
		// 		Symbol(Symbol.iterator),
		// 		Symbol(Symbol.match),
		// 		Symbol(Symbol.replace),
		// 		Symbol(Symbol.search),
		// 		Symbol(Symbol.species),
		// 		Symbol(Symbol.split),
		// 		Symbol(Symbol.toPrimitive),
		// 		Symbol(Symbol.toStringTag),
		// 		Symbol(Symbol.unscopables)
		// }
		.filter(isSymbol));
	
	// get拦截
	const get = /*#__PURE__*/ createGetter();
	// 浅层的get拦截
	const shallowGet = /*#__PURE__*/ createGetter(false, true);
	// 只读的get拦截
	const readonlyGet = /*#__PURE__*/ createGetter(true);
	// 浅层只读的get拦截
	const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true);

	// 重新定义数组原型上的方法
	const arrayInstrumentations = {};
	['includes', 'indexOf', 'lastIndexOf'].forEach(key => {
		const method = Array.prototype[key];
		arrayInstrumentations[key] = function (...args) {
			// 因为在createGetter方法执行时，使用的是Reflect.get(arrayInstrumentations, key, receiver)
			// 所以this执行receiver，而receiver为原始的读操作所在的那个对象，即arr为一个数组
			// e.g. 
			// let obj = {};
			// let array = [obj, obj, obj];
			// array.includes(obj) => arr === array
			const arr = toRaw(this);
			// this为arrayInstrumentations数组
			for (let i = 0, l = this.length; i < l; i++) {
				// 遍历原始数组，添加追踪记录
				track(arr, "get" /* GET */, i + '');
			}
			// 使用系统自带的方法执行
			const res = method.apply(arr, args);
			if (res === -1 || res === false) {
				// 如果找不到，则用数组的原始值来执行
				// e.g. 
				// 原生的includes方法接收两个参数，第一个参数为需要查找的值，第二个参数表示搜索的起始位置。
				// let array = [1, 2, 3, 4];
				// array.includes(3, 1); => true
				// args => [3, 1]
				return method.apply(arr, args.map(toRaw));
			}
			else {
				return res;
			}
		};
	});
	['push', 'pop', 'shift', 'unshift', 'splice'].forEach(key => {
		const method = Array.prototype[key];
		arrayInstrumentations[key] = function (...args) {
			// 暂停跟踪记录，因为如果当数组已经是一个响应式对象，proxy能够监听到数组的增删操作
			pauseTracking();
			const res = method.apply(this, args);
			// 重置是否需要跟踪记录
			resetTracking();
			return res;
		};
	});

	/**
	 * 创建proxy拦截
	 * @param {Object} isReadonly 是否为只读
	 * @param {Boolean} shallow 是否为浅层拦截
	 */
	function createGetter(isReadonly = false, shallow = false) {
		/**
		 * @param {Object|Array} target 目标对象
		 * @param {*} key 属性名
		 * @param {Object|Array} receiver 可选。总是执行原始的读操作所在的那个对象，一般情况下就是Proxy实例
		 */
		return function get(target, key, receiver) {
			if (key === "__v_isReactive" /* IS_REACTIVE */) {
				// 不为只读则为响应式的
				return !isReadonly;
			}
			else if (key === "__v_isReadonly" /* IS_READONLY */) {
				return isReadonly;
			}
			else if (key === "__v_raw" /* RAW */ &&
				receiver === (isReadonly ? readonlyMap : reactiveMap).get(target)) {
				return target;
			}
			// 如果目标对象为数组类型
			const targetIsArray = isArray(target);
			// arrayInstrumentations => 'include', 'indexOf', 'lastIndexOf', 'push', 'pop', 'shift', 'unshift', 'splice'
			if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
				return Reflect.get(arrayInstrumentations, key, receiver);
			}
			const res = Reflect.get(target, key, receiver);
			if (isSymbol(key)
				? builtInSymbols.has(key)
				: key === `__proto__` || key === `__v_isRef`) {
				return res;
			}
			if (!isReadonly) {
				track(target, "get" /* GET */, key);
			}
			// 如果为浅层监听，则直接返回res
			if (shallow) {
				return res;
			}
			if (isRef(res)) {
				const shouldUnwrap = !targetIsArray || !isIntegerKey(key);
				return shouldUnwrap ? res.value : res;
			}
			if (isObject(res)) {
				return isReadonly ? readonly(res) : reactive(res);
			}
			return res;
		};
	}
	// set拦截
	const set = /*#__PURE__*/ createSetter();
	// 浅层的set拦截
	const shallowSet = /*#__PURE__*/ createSetter(true);
	/**
	 * 创建proxy拦截
	 * @param {Boolean} shallow 是否为浅层拦截
	 */
	function createSetter(shallow = false) {
		/**
		 * @param {Object|Array} target 目标对象
		 * @param {*} key 属性名
		 * @param {*} value 属性值
		 * @param {Object|Array} receiver 可选。总是执行原始的读操作所在的那个对象，一般情况下就是Proxy实例
		 */
		return function set(target, key, value, receiver) {
			const oldValue = target[key];
			if (!shallow) {
				// 获取value的原始值 TODO isRef有什么作用
				value = toRaw(value);
				if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
					oldValue.value = value;
					return true;
				}
			}
			const hadKey = isArray(target) && isIntegerKey(key)
				? Number(key) < target.length
				: hasOwn(target, key);
			const result = Reflect.set(target, key, value, receiver);

			// 如果目标对象是在原始原始的原型链中出现的东西，则不需要执行添加或重新赋值触发器
			/*
				e.g.
				let protoObj = {};
				const proxy = new Proxy(protoObj, {
					set: function (target, key, reveiver) {
						return receiver;
					}
				});
				const newObj = Object.create(proxy);
				newObj.name = "fanqiewa";

				当给newObj赋值时，此时reveiver为newObj，target为protoObj，
				所以这个对象不相等，不需要执行触发器。
				如果是protoObj.name = "fanqiewa"，则需要执行触发器
			*/
			if (target === toRaw(receiver)) {
				if (!hadKey) {
					// 触发添加触发器
					trigger(target, "add" /* ADD */, key, value);
				}
				else if (hasChanged(value, oldValue)) {
					// 如果新值和旧值不一样，则触发赋值触发器
					trigger(target, "set" /* SET */, key, value, oldValue);
				}
			}
			return result;
		};
	}
	// proxy拦截delete操作
	function deleteProperty(target, key) {
		const hadKey = hasOwn(target, key);
		const oldValue = target[key];
		// 调用Reflect执行delete操作
		const result = Reflect.deleteProperty(target, key);
		// 如果删除成功且含有这个key属性，则执行删除触发器
		if (result && hadKey) {
			trigger(target, "delete" /* DELETE */, key, undefined, oldValue);
		}
		return result;
	}
	// proxy的has拦截
	function has(target, key) {
		const result = Reflect.has(target, key);
		// 如果key值不为symbol类型或者Symbol对象自带的symbol类型，则添加跟踪记录
		if (!isSymbol(key) || !builtInSymbols.has(key)) {
			track(target, "has" /* HAS */, key);
		}
		return result;
	}
	// proxy的ownKeys拦截，用于拦截对象自身属性的读取操作
	function ownKeys(target) {
		track(target, "iterate" /* ITERATE */, isArray(target) ? 'length' : ITERATE_KEY);
		return Reflect.ownKeys(target);
	}
	// 可变的操作对象
	const mutableHandlers = {
		get,
		set,
		deleteProperty,
		has,
		ownKeys
	};
	const readonlyHandlers = {
		get: readonlyGet,
		set(target, key) {
			{
				// 目标对象是只读的，不能重新赋值
				console.warn(`Set operation on key "${String(key)}" failed: target is readonly.`, target);
			}
			return true;
		},
		deleteProperty(target, key) {
			{
				// 目标对象是只读的，不能删除属性
				console.warn(`Delete operation on key "${String(key)}" failed: target is readonly.`, target);
			}
			return true;
		}
	};
	// 浅层的响应式操作对象
	const shallowReactiveHandlers = extend({}, mutableHandlers, {
		get: shallowGet,
		set: shallowSet
	});
	// 浅层的只读响应式操作对象
	const shallowReadonlyHandlers = extend({}, readonlyHandlers, {
		get: shallowReadonlyGet
	});

	// 如果传入参数为对象或数组，则将传入参数转成响应式对象
	const toReactive = (value) => isObject(value) ? reactive(value) : value;
	// 将传入参数转成只读的响应式对象
	const toReadonly = (value) => isObject(value) ? readonly(value) : value;
	// 将传入对象转成浅层的对象
	const toShallow = (value) => value;
	// 获取对象的原型
	const getProto = (v) => Reflect.getPrototypeOf(v);
	// Map、Set、WeakMap、WeakSet的get方法拦截
	function get$1(target, key, isReadonly = false, isShallow = false) {
		
		// target目标对象的读取操作会触发createInstrumentationGetter函数被调用时返回的闭包函数
		// 读取目标对象的__v_raw时，会返回目标的原始对象
		target = target["__v_raw" /* RAW */];
		const rawTarget = toRaw(target);
		const rawKey = toRaw(key);
		if (key !== rawKey) {
			// 如果原始的key值和当前的key值不相等，且不是只读属性，则触发get跟踪记录，key为当前key
			!isReadonly && track(rawTarget, "get" /* GET */, key);
		}
		// 不是只读属性，触发get跟踪记录，key为原始key
		!isReadonly && track(rawTarget, "get" /* GET */, rawKey);
		const { has } = getProto(rawTarget);
		const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive;
		if (has.call(rawTarget, key)) {
			// 使用roReactive或toReadonly或toShallow包裹执行一下
			// 根据key值的类型，转成相应的响应式对象或只读的响应式对象或浅层的对象
			return wrap(target.get(key));
		}
		else if (has.call(rawTarget, rawKey) /* 如果原始对象含有原始key值 */) {
			return wrap(target.get(rawKey));
		}
	}
	// Map、Set、WeakMap、WeakSet的has方法拦截
	function has$1(key, isReadonly = false) {
		// target默认为Proxy的实例对象，其它情况下执行原始的读操作所在的那个对象
		const target = this["__v_raw" /* RAW */];
		const rawTarget = toRaw(target);
		const rawKey = toRaw(key);
		if (key !== rawKey) {
			!isReadonly && track(rawTarget, "has" /* HAS */, key);
		}
		!isReadonly && track(rawTarget, "has" /* HAS */, rawKey);
		return key === rawKey
			? target.has(key)
			: target.has(key) || target.has(rawKey);
	}
	// Map、Set、WeakMap、WeakSet的size方法拦截
	function size(target, isReadonly = false) {
		target = target["__v_raw" /* RAW */];
		// 不是只读属性，触发iterate跟踪记录，key为原始ITERATE_KEY
		!isReadonly && track(toRaw(target), "iterate" /* ITERATE 迭代 */, ITERATE_KEY);
		return Reflect.get(target, 'size', target);
	}
	// Map、Set、WeakMap、WeakSet的add方法拦截
	function add(value) {
		value = toRaw(value);
		const target = toRaw(this);
		const proto = getProto(target);
		const hadKey = proto.has.call(target, value);
		const result = target.add(value);
		if (!hadKey) {
			// 如果key值不存在，则执行添加触发器
			trigger(target, "add" /* ADD */, value, value);
		}
		return result;
	}
	// Map、Set、WeakMap、WeakSet的set方法拦截
	function set$1(key, value) {
		value = toRaw(value);
		const target = toRaw(this); // 当前执行读操作的对象，如果不存在，则为proxy对象
		const { has, get } = getProto(target);
		let hadKey = has.call(target, key);
		// 如果key值不存在，则栈key的原始值 TODO
		if (!hadKey) {
			key = toRaw(key);
			hadKey = has.call(target, key);
		}
		else {
			// 响应式版本的key值存在
			checkIdentityKeys(target, has, key);
		}
		const oldValue = get.call(target, key);
		const result = target.set(key, value);
		if (!hadKey) {
			// 如果原始的key和响应式的key都不存在，则触发添加触发器
			trigger(target, "add" /* ADD */, key, value);
		}
		else if (hasChanged(value, oldValue)) {
			// 如果只是新旧值改变了，则触发赋值触发器
			trigger(target, "set" /* SET */, key, value, oldValue);
		}
		return result;
	}
	// Map、Set、WeakMap、WeakSet的delete方法拦截
	function deleteEntry(key) {
		const target = toRaw(this);
		const { has, get } = getProto(target);
		let hadKey = has.call(target, key);
		if (!hadKey) {
			key = toRaw(key);
			hadKey = has.call(target, key);
		}
		else {
			checkIdentityKeys(target, has, key);
		}
		const oldValue = get ? get.call(target, key) : undefined;
		const result = target.delete(key);
		if (hadKey) {
			trigger(target, "delete" /* DELETE */, key, undefined, oldValue);
		}
		return result;
	}
	// Map、Set、WeakMap、WeakSet的clear方法拦截
	function clear() {
		const target = toRaw(this);
		const hadItems = target.size !== 0;
		const oldTarget = isMap(target)
			? new Map(target)
			: new Set(target)
			;
		const result = target.clear();
		if (hadItems) {
			trigger(target, "clear" /* CLEAR */, undefined, undefined, oldTarget);
		}
		return result;
	}
	// Map、Set、WeakMap、WeakSet的forEach方法拦截
	function createForEach(isReadonly, isShallow) {
		return function forEach(callback, thisArg) {
			const observed = this; // proxy对象
			const target = observed["__v_raw" /* RAW */]; // target目标对象
			const rawTarget = toRaw(target);
			const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive;
			// 不是只读属性，触发iterate跟踪记录，key为ITERATE_KEY
			!isReadonly && track(rawTarget, "iterate" /* ITERATE */, ITERATE_KEY);
			return target.forEach((value, key) => {
				// 键名、键值、集合本身
				return callback.call(thisArg, wrap(value), wrap(key), observed);
			});
		};
	}
	// 创建可迭代的方法的拦截
	function createIterableMethod(method, isReadonly, isShallow) {
		return function (...args) {
			const target = this["__v_raw" /* RAW */];
			const rawTarget = toRaw(target);
			const targetIsMap = isMap(rawTarget);
			// entries方法和Symbol.iterator相等
			const isPair /* 是否为一对属性值 */ = method === 'entries' || (method === Symbol.iterator && targetIsMap);
			const isKeyOnly = method === 'keys' && targetIsMap;

			// 执行目标对象的迭代方法返回一个迭代器
			const innerIterator = target[method](...args);
			const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive;
			// 不是只读属性，触发iterate跟踪记录，key为Symbol( 'Map key iterate' ) 或 Symbol( 'iterate' )
			!isReadonly &&
				track(rawTarget, "iterate" /* ITERATE */, isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY);
			return {
				next() {
					// 执行迭代器会返回数据结构的当前成员的信息
					const { value /* 当前成员的值 */, done /* 布尔值，表示遍历是否结束 */ } = innerIterator.next();
					return done
						? { value, done }
						: {
							value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
							done
						};
				},
				// 表明该对象是可迭代的
				// 一个数据结构只要具有Symbol.iterator属性，就可以认为是`可遍历的`
				[Symbol.iterator]() {
					return this;
				}
			};
		};
	}
	// 创建只读的拦截方法 e.g. add、set、delete、clear、forEach
	function createReadonlyMethod(type) {
		return function (...args) {
			{
				// 不执行任何操作，直接发出警告信息，表示该方法是只读的
				const key = args[0] ? `on key "${args[0]}" ` : ``;
				console.warn(`${capitalize(type)} operation ${key}failed: target is readonly.`, toRaw(this));
			}
			return type === "delete" /* DELETE */ ? false : this;
		};
	}
	// 可变的检测
	// mutableInstrumentations对象是通过Reflect.getAPI查找并返回属性的，
	// Reflect.get的第三个参数传递了receiver，表示proxy对象
	// 在调用createInstrumentationGetter方法创建get拦截时，返回了一个闭包函数
	const mutableInstrumentations = {
		get(key) {
			// this执行receiver，即proxy对象
			return get$1(this, key);
		},
		get size() {
			return size(this);
		},
		has: has$1,
		add,
		set: set$1,
		delete: deleteEntry,
		clear,
		forEach: createForEach(false, false)
	};
	// 浅层的检测
	const shallowInstrumentations = {
		get(key) {
			return get$1(this, key, false, true);
		},
		get size() {
			return size(this);
		},
		has: has$1,
		add,
		set: set$1,
		delete: deleteEntry,
		clear,
		forEach: createForEach(false, true)
	};
	// 只读的检测
	const readonlyInstrumentations = {
		get(key) {
			return get$1(this, key, true);
		},
		get size() {
			return size(this, true);
		},
		has(key) {
			return has$1.call(this, key, true);
		},
		add: createReadonlyMethod("add" /* ADD */),
		set: createReadonlyMethod("set" /* SET */),
		delete: createReadonlyMethod("delete" /* DELETE */),
		clear: createReadonlyMethod("clear" /* CLEAR */),
		forEach: createForEach(true, false)
	};
	const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator];
	iteratorMethods.forEach(method => {
		mutableInstrumentations[method] = createIterableMethod(method, false, false);
		readonlyInstrumentations[method] = createIterableMethod(method, true, false);
		shallowInstrumentations[method] = createIterableMethod(method, false, true);
	});
	// 创建getter拦截检测
	function createInstrumentationGetter(isReadonly, shallow) {
		const instrumentations = shallow
			? shallowInstrumentations
			: isReadonly
				? readonlyInstrumentations
				: mutableInstrumentations;
		return (target, key, receiver) => {
			if (key === "__v_isReactive" /* IS_REACTIVE */) {
				return !isReadonly;
			}
			else if (key === "__v_isReadonly" /* IS_READONLY */) {
				return isReadonly;
			}
			else if (key === "__v_raw" /* RAW */) {
				return target;
			}
			// 如果key为get、size、has、add、set、delete、clear、forEach，则会调用想要的拦截
			return Reflect.get(hasOwn(instrumentations, key) && key in target
				? instrumentations
				: target, key, receiver);
		};
	}
	const mutableCollectionHandlers = {
		get: createInstrumentationGetter(false, false)
	};
	// 浅层的集合操作对象
	const shallowCollectionHandlers = {
		get: createInstrumentationGetter(false, true)
	};
	const readonlyCollectionHandlers = {
		get: createInstrumentationGetter(true, false)
	};
	// 检查key值的原始值和当前值是否一致
	function checkIdentityKeys(target, has, key) {
		const rawKey = toRaw(key);
		if (rawKey !== key && has.call(target, rawKey)) {
			const type = toRawType(target);
			// 响应式对象包含原始和响应式的两个不同版本的key值
			// 这可能会导致不稳定
			// 如果可以的话，只使用响应式版本的key
			console.warn(`Reactive ${type} contains both the raw and reactive ` +
				`versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
				`which can lead to inconsistencies. ` +
				`Avoid differentiating between the raw and reactive versions ` +
				`of an object and only use the reactive version if possible.`);
		}
	}

	const reactiveMap = new WeakMap();
	const readonlyMap = new WeakMap();
	// 根据目标对象的原始类型返回状态 0 | 1 | 2
	function targetTypeMap(rawType) {
		switch (rawType) {
			case 'Object':
			case 'Array':
				return 1 /* COMMON */;
			case 'Map':
			case 'Set':
			case 'WeakMap':
			case 'WeakSet':
				return 2 /* COLLECTION */;
			default:
				return 0 /* INVALID */;
		}
	}
	// 获取对象的类型
	function getTargetType(value) {
		// Object.isExtensible用来判断一个对象是否可扩展
		return value["__v_skip" /* SKIP */] || !Object.isExtensible(value)
			? 0 /* INVALID */
			: targetTypeMap(toRawType(value));
	}
	// 创建响应式对象
	function reactive(target) {
		// 如果试图去监听一个只读读proxy对象，则直接返回该只读的观察者对象
		if (target && target["__v_isReadonly" /* IS_READONLY */]) {
			return target;
		}
		return createReactiveObject(target, false, mutableHandlers, mutableCollectionHandlers);
	}
	// 创建浅层的响应式对象
	function shallowReactive(target) {
		return createReactiveObject(target, false, shallowReactiveHandlers, shallowCollectionHandlers);
	}
	// 创建只读的响应式对象
	function readonly(target) {
		return createReactiveObject(target, true, readonlyHandlers, readonlyCollectionHandlers);
	}
	// 创建只读的响应式对象
	function shallowReadonly(target) {
		return createReactiveObject(target, true, shallowReadonlyHandlers, readonlyCollectionHandlers);
	}
	/**
	 * 创建proxy监听对象
	 * @param {Object|Array} target 监听的目标对象
	 * @param {Boolean} isReadonly 是否为只读
	 * @param {Function} baseHandlers 基本数据类型的拦截器（拦截Object和Array）
	 * @param {Function} collectionHandlers 集合类型的拦截器（拦截Map、Set和WeakSet）
	 */
	function createReactiveObject(target, isReadonly, baseHandlers, collectionHandlers) {
		if (!isObject(target)) {
			{
				// proxy只能监听对象和数组
				console.warn(`value cannot be made reactive: ${String(target)}`);
			}
			return target;
		}
		// 目标对象已经是一个proxy对象，直接返回目标对象
		if (target["__v_raw" /* RAW */] && // target为一个原始对象
			// 目标对象不是只读的或者目标对象已经是一个响应式对象
			!(isReadonly && target["__v_isReactive" /* IS_REACTIVE */])) {
			return target;
		}
		
		const proxyMap = isReadonly ? readonlyMap : reactiveMap;
		const existingProxy = proxyMap.get(target);
		if (existingProxy) {
			// 目标对象已经有了相应的代理
			return existingProxy;
		}
		
		// 只能观察到一个值类型的白名单
		const targetType = getTargetType(target);
		if (targetType === 0 /* INVALID */) {
			return target;
		}
		const proxy = new Proxy(target, targetType === 2 /* COLLECTION */ ? collectionHandlers : baseHandlers);
		// 往readonlyMap或reactiveMap对象中添加target属性，值为target代理过或返回的对象
		// 在执行toRaw()方法时，有用到
		proxyMap.set(target, proxy);
		return proxy;
	}
	// 判断传入参数是否为响应式对象
	function isReactive(value) {
		if (isReadonly(value)) {
			return isReactive(value["__v_raw" /* RAW */]);
		}
		return !!(value && value["__v_isReactive" /* IS_REACTIVE */]);
	}
	// 判断传入参数是否为只读的对象
	function isReadonly(value) {
		return !!(value && value["__v_isReadonly" /* IS_READONLY */]);
	}
	// 判断传入参数是否为proxy对象（响应式或者只读的）
	function isProxy(value) {
		return isReactive(value) || isReadonly(value);
	}
	// 获取观察者对象的原始对象（没被proxy修饰过）
	function toRaw(observed) {
		return ((observed && toRaw(observed["__v_raw" /* RAW */])) || observed);
	}
	// 定义一个对象是否可更改为响应式对象（skip => 跳过）
	function markRaw(value) {
		def(value, "__v_skip" /* SKIP */, true);
		return value;
	}

	/**
	 * ref
	 ***************************************************************/

	// 将对象类型的参数转成响应式对象
	const convert = (val) => isObject(val) ? reactive(val) : val;
	// reference =>
	// 引用 => 修改响应式数据会影响原始数据，数据变化不会自动更新界面
	// 复制 => 修改响应式数据不会影响原始数据，数据变化会更新视图
	// 判断一个传入参数是否为ref对象
	function isRef(r) {
		return Boolean(r && r.__v_isRef === true);
	}
	// 创建ref对象 ==> 复制
	function ref(value) {
		return createRef(value);
	}
	// 创建浅层的ref对象 ==> 复制
	function shallowRef(value) {
		return createRef(value, true);
	}
	// 复制类型的ref对象实现类
	class RefImpl {
		constructor(_rawValue, _shallow = false) {
			this._rawValue = _rawValue;
			this._shallow = _shallow;
			this.__v_isRef = true;
			// 如果为浅层的，返回原始数据，否则将_value转成响应式对象
			this._value = _shallow ? _rawValue : convert(_rawValue);
		}
		get value() {
			track(toRaw(this), "get" /* GET */, 'value');
			return this._value;
		}
		set value(newVal) {
			if (hasChanged(toRaw(newVal), this._rawValue)) {
				this._rawValue = newVal;
				this._value = this._shallow ? newVal : convert(newVal);
				trigger(toRaw(this), "set" /* SET */, 'value', newVal);
			}
		}
	}
	// 创建ref对象
	function createRef(rawValue, shallow = false) {
		if (isRef(rawValue)) {
			return rawValue;
		}
		return new RefImpl(rawValue, shallow);
	}
	function triggerRef(ref) {
		trigger(toRaw(ref), "set" /* SET */, 'value', ref.value);
	}
	// ref.value将处罚跟踪记录
	function unref(ref) {
		return isRef(ref) ? ref.value : ref;
	}
	const shallowUnwrapHandlers = {
		// 如果获取的属性为ref类型，则触发响应，更新界面
		get: (target, key, receiver) => unref(Reflect.get(target, key, receiver)),
		set: (target, key, value, receiver) => {
			const oldValue = target[key];
			if (isRef(oldValue) && !isRef(value)) {
				oldValue.value = value;
				return true;
			}
			else {
				return Reflect.set(target, key, value, receiver);
			}
		}
	};
	// 将refs数据类型添加响应
	function proxyRefs(objectWithRefs) {
		return isReactive(objectWithRefs)
			? objectWithRefs
			: new Proxy(objectWithRefs, shallowUnwrapHandlers);
	}
	// 自定义ref类型数据的实现类
	class CustomRefImpl {
		constructor(factory) {
			this.__v_isRef = true;
			const { get, set } = factory(() => track(this, "get" /* GET */, 'value'), () => trigger(this, "set" /* SET */, 'value'));
			this._get = get;
			this._set = set;
		}
		get value() {
			return this._get();
		}
		set value(newVal) {
			this._set(newVal);
		}
	}
	/**
	 * 自定义ref类型数据
	 * @param {Function} factory 回调函数，执行该函数，传入两个对象，第一个为执行get跟踪记录后的返回值，第二个为执行set跟踪记录的返回值
	 */
	function customRef(factory) {
		return new CustomRefImpl(factory);
	}

	// 批量创建ref数据类型的数据，并和以前的数据关联
	function toRefs(object) {
		if (!isProxy(object)) {
			// toRefs期待的是一个响应式对象
			console.warn(`toRefs() expects a reactive object but received a plain one.`);
		}
		const ret = isArray(object) ? new Array(object.length) : {};
		for (const key in object) {
			ret[key] = toRef(object, key);
		}
		return ret;
	}

	// 引用类型的ref类型数据实现类
	class ObjectRefImpl {
		constructor(_object, _key) {
			this._object = _object;
			this._key = _key;
			this.__v_isRef = true;
		}
		get value() {
			return this._object[this._key];
		}
		set value(newVal) {
			this._object[this._key] = newVal;
		}
	}
	// 创建一个ref类型数据，并和以前的数据关联
	function toRef(object, key) {
		return isRef(object[key])
			? object[key]
			: new ObjectRefImpl(object, key);
	}
	
	// computed计算属性的引用实现类
	class ComputedRefImpl {
		constructor(getter, _setter, isReadonly) {
			this._setter = _setter;
			this._dirty = true;
			this.__v_isRef = true;
			this.effect = effect(getter, {
				lazy: true,
				// TODO 关于scheduler是什么？有什么用
				scheduler: () => {
					if (!this._dirty) {
						this._dirty = true;
						trigger(toRaw(this), "set" /* SET */, 'value');
					}
				}
			});
			this["__v_isReadonly" /* IS_READONLY */] = isReadonly;
		}
		get value() {
			if (this._dirty) {
				// 第一次执行get获取值时，触发响应方法，执行getter
				this._value = this.effect();
				this._dirty = false;
			}
			// 添加computed的get跟踪记录
			track(toRaw(this), "get" /* GET */, 'value');
			return this._value;
		}
		set value(newValue) {
			// 执行computed计算属性的set赋值时，会执行set方法，该方法里面如果有data定义的响应式对象，则会触发响应
			this._setter(newValue);
		}
	}
	// 创建计算属性
	function computed(getterOrOptions) {
		let getter;
		let setter;
		if (isFunction(getterOrOptions)) {
			getter = getterOrOptions;
			setter = () => {
				// e.g. Vue.computed(function getSomething() {}) => 传入getterOrOptions为一个函数，则computed的值为只读的
				console.warn('Write operation failed: computed value is readonly');
			}
				;
		}
		else {
			// e.g. 
			// let getSomething = { get: function () { }, set: function () { } }
			// e.g. Vue.computed(getSomething) => 传入getterOrOptions为一个对象
			getter = getterOrOptions.get;
			setter = getterOrOptions.set;
		}
		//  返回computed的引用实现实例
		return new ComputedRefImpl(getter, setter, isFunction(getterOrOptions) || !getterOrOptions.set);
	}

	/**
	 * Vue平台错误处理
	 ***************************************************************/
	// 暂存vnode节点的堆栈
	const stack = [];
	// 添加warning上下文
	function pushWarningContext(vnode) {
		stack.push(vnode);
	}
	// 移除warning上下文
	function popWarningContext() {
		stack.pop();
	}
	// Vue平台警告函数
	function warn(msg, ...args) {
		// 避免使用跟踪记录，因为在警告处理程序可能会在patch期间发生异变，导致无限递归
		pauseTracking();
		const instance = stack.length ? stack[stack.length - 1].component : null;
		const appWarnHandler /* 自定义警告方法 */ = instance && instance.appContext.config.warnHandler;
		const trace = getComponentTrace();
		if (appWarnHandler) {
			callWithErrorHandling(appWarnHandler, instance, 11 /* APP_WARN_HANDLER */, [

				// 执行Application Config的warnHandler
				msg + args.join(''), /* msg */
				instance && instance.proxy, /* vm */
				trace
					.map(({ vnode }) => `at <${formatComponentName(instance, vnode.type)}>`)
					.join('\n'), // 格式化trace为换行字符串
				trace /* trace */
			]);
		}
		else {
			// e.g. '[Vue warn]: Unhandled error during execution of setup function'
			const warnArgs = [`[Vue warn]: ${msg}`, ...args];
			if (trace.length &&
				!false) {
				warnArgs.push(`\n`, ...formatTrace(trace));
			}
			/*
				e.g. 
				[Vue warn]: Unhandled error during execution of setup function
					at <Child isdetail="fanqiewa" >
					at <App>
			*/
			console.warn(...warnArgs);
		}
		resetTracking();
	}
	// 获取组件的轨迹（将stack格式化后的堆栈normalizedStack） => 轨迹：父 => 子
	function getComponentTrace() {
		let currentVNode = stack[stack.length - 1];
		if (!currentVNode) {
			return [];
		}
		// 我们不能直接使用堆栈，因为它不是完整的从根节点开始入栈的
		// 使用实例的父指针重新构造父链
		// 格式化后的堆栈
		const normalizedStack = [];
		while (currentVNode) {
			const last = normalizedStack[0];
			if (last && last.vnode === currentVNode) {
				last.recurseCount++;
			}
			else {
				normalizedStack.push({
					vnode: currentVNode,
					recurseCount: 0
				});
			}
			const parentInstance = currentVNode.component && currentVNode.component.parent;
			currentVNode = parentInstance && parentInstance.vnode;
		}
		return normalizedStack;
	}
	// 格式化轨迹
	function formatTrace(trace) {
		const logs = [];
		trace.forEach((entry, i) => {
			logs.push(...(i === 0 ? [] : [`\n`]), ...formatTraceEntry(entry));
		});
		return logs;
	}
	// 格式化每一项轨迹
	function formatTraceEntry({ vnode, recurseCount }) {
		const postfix = recurseCount > 0 ? `... (${recurseCount} recursive calls)` : ``;
		const isRoot = vnode.component ? vnode.component.parent == null : false;
		const open = ` at <${formatComponentName(vnode.component, vnode.type, isRoot)}`;
		const close = `>` + postfix;
		return vnode.props
			? [open, ...formatProps(vnode.props), close]
			: [open + close];
	}
	// 格式化属性
	function formatProps(props) {
		const res = [];
		const keys = Object.keys(props);
		keys.slice(0, 3).forEach(key => {
			res.push(...formatProp(key, props[key]));
		});
		// 如果超过3个，则用`...`表示
		if (keys.length > 3) {
			res.push(` ...`);
		}
		return res;
	}
	// 格式化属性名和属性值
	function formatProp(key, value, raw /* 是否返回原始的属性值 */) {
		if (isString(value)) {
			value = JSON.stringify(value);
			return raw ? value : [`${key}=${value}`];
		}
		else if (typeof value === 'number' ||
			typeof value === 'boolean' ||
			value == null) {
			return raw ? value : [`${key}=${value}`];
		}
		else if (isRef(value)) {
			// 如果为ref类型的属性值，则取ref的原始value值
			value = formatProp(key, toRaw(value.value), true);
			return raw ? value : [`${key}=Ref<`, value, `>`];
		}
		else if (isFunction(value)) {
			return [`${key}=fn${value.name ? `<${value.name}>` : ``}`];
		}
		else {
			value = toRaw(value);
			return raw ? value : [`${key}=`, value];
		}
	}

	// 错误类型
	const ErrorTypeStrings = {
		["bc" /* BEFORE_CREATE */]: 'beforeCreate hook',
		["c" /* CREATED */]: 'created hook',
		["bm" /* BEFORE_MOUNT */]: 'beforeMount hook',
		["m" /* MOUNTED */]: 'mounted hook',
		["bu" /* BEFORE_UPDATE */]: 'beforeUpdate hook',
		["u" /* UPDATED */]: 'updated',
		["bum" /* BEFORE_UNMOUNT */]: 'beforeUnmount hook',
		["um" /* UNMOUNTED */]: 'unmounted hook',
		["a" /* ACTIVATED */]: 'activated hook',
		["da" /* DEACTIVATED */]: 'deactivated hook',
		["ec" /* ERROR_CAPTURED */]: 'errorCaptured hook',
		["rtc" /* RENDER_TRACKED */]: 'renderTracked hook',
		["rtg" /* RENDER_TRIGGERED */]: 'renderTriggered hook',
		[0 /* SETUP_FUNCTION */]: 'setup function',
		[1 /* RENDER_FUNCTION */]: 'render function',
		[2 /* WATCH_GETTER */]: 'watcher getter',
		[3 /* WATCH_CALLBACK */]: 'watcher callback',
		[4 /* WATCH_CLEANUP */]: 'watcher cleanup function',
		[5 /* NATIVE_EVENT_HANDLER */]: 'native event handler',
		[6 /* COMPONENT_EVENT_HANDLER */]: 'component event handler',
		[7 /* VNODE_HOOK */]: 'vnode hook',
		[8 /* DIRECTIVE_HOOK */]: 'directive hook',
		[9 /* TRANSITION_HOOK */]: 'transition hook',
		[10 /* APP_ERROR_HANDLER */]: 'app errorHandler',
		[11 /* APP_WARN_HANDLER */]: 'app warnHandler',
		[12 /* FUNCTION_REF */]: 'ref function',
		[13 /* ASYNC_COMPONENT_LOADER */]: 'async component loader',
		[14 /* SCHEDULER */]: 'scheduler flush. This is likely a Vue internals bug. ' +
			'Please open an issue at https://new-issue.vuejs.org/?repo=vuejs/vue-next'
	};
	// 用try catch包裹执行回调函数，以便处理错误信息
	function callWithErrorHandling(fn, instance, type, args) {
		let res;
		try {
			res = args ? fn(...args) : fn();
		}
		catch (err) {
			handleError(err, instance, type);
		}
		return res;
	}
	function callWithAsyncErrorHandling(fn, instance, type, args) {
		if (isFunction(fn)) {
			const res = callWithErrorHandling(fn, instance, type, args);
			if (res && isPromise(res)) {
				res.catch(err => {
					handleError(err, instance, type);
				});
			}
			return res;
		}
		const values = [];
		for (let i = 0; i < fn.length; i++) {
			values.push(callWithAsyncErrorHandling(fn[i], instance, type, args));
		}
		return values;
	}
	// 处理错误函数
	function handleError(err, instance, type, throwInDev = true) {
		const contextVNode = instance ? instance.vnode : null;
		if (instance) {
			let cur = instance.parent;
			const exposedInstance = instance.proxy;
			// 错误信息
			const errorInfo = ErrorTypeStrings[type];
			while (cur) { // TODO
				const errorCapturedHooks = cur.ec;
				if (errorCapturedHooks) {
					for (let i = 0; i < errorCapturedHooks.length; i++) {
						if (errorCapturedHooks[i](err, exposedInstance, errorInfo) === false) {
							return;
						}
					}
				}
				cur = cur.parent;
			}
			// 用户自定义的错误函数
			const appErrorHandler = instance.appContext.config.errorHandler;
			if (appErrorHandler) {
				callWithErrorHandling(appErrorHandler, null, 10 /* APP_ERROR_HANDLER */, [err, exposedInstance, errorInfo]);
				return;
			}
		}
		logError(err, type, contextVNode, throwInDev);
	}
	// 错误日志
	function logError(err, type, contextVNode, throwInDev = true) {
		{
			const info = ErrorTypeStrings[type];
			if (contextVNode) {
				pushWarningContext(contextVNode);
			}
			warn(`Unhandled error${info ? ` during execution of ${info}` : ``}`);
			if (contextVNode) {
				popWarningContext();
			}
			// crash in dev by default so it's more noticeable
			if (throwInDev) {
				throw err;
			}
			else {
				console.error(err);
			}
		}
	}

	/**
	 * 执行任务队列
	 * flush -> 冲刷（刷新），释为执行，缓冲
	 ***************************************************************/

	let isFlushing = false; // 是否正在刷新队列
	let isFlushPending = false; // 是否属于等待中
	const queue = []; // 任务队列列表
	let flushIndex = 0; // 当前刷新的索引
	const pendingPreFlushCbs = []; // 前置队列等待中的回调函数
	let activePreFlushCbs = null; // 前置队列正在执行的回调函数
	let preFlushIndex = 0; // 前置队列刷新的索引
	const pendingPostFlushCbs = []; // 后置队列等待中的回调函数
	let activePostFlushCbs = null; // 后置队列正在执行的回调函数
	let postFlushIndex = 0; // 前置队列刷新的索引
	const resolvedPromise = Promise.resolve(); //
	let currentFlushPromise = null; // 当前刷新队列的Promise对象
	let currentPreFlushParentJob = null; // 当前前置队列的任务
	const RECURSION_LIMIT = 100; // 循环上限
	// VM.$nextTick
	function nextTick(fn) {
		const p = currentFlushPromise || resolvedPromise;
		return fn ? p.then(this ? fn.bind(this) : fn) : p;
	}
	// 添加任务到任务队列中
	function queueJob(job) {
		if ((!queue.length ||
			!queue.includes(job, isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex)) &&
			job !== currentPreFlushParentJob) {
			queue.push(job);
			queueFlush();
		}
	}
	// 刷新任务
	function queueFlush() {
		if (!isFlushing && !isFlushPending) {
			isFlushPending = true;
			currentFlushPromise = resolvedPromise.then(flushJobs);
		}
	}
	// 去除无效的队列
	function invalidateJob(job) {
		const i = queue.indexOf(job);
		if (i > -1) {
			queue[i] = null;
		}
	}
	// 添加回调函数到等待队列中，并刷新回调队列
	function queueCb(cb, activeQueue, pendingQueue, index) {
		if (!isArray(cb)) {
			if (!activeQueue ||
				!activeQueue.includes(cb, cb.allowRecurse ? index + 1 : index)) {
				pendingQueue.push(cb);
			}
		}
		else {
			pendingQueue.push(...cb);
		}
		queueFlush();
	}
	// 刷新后置任务队列的回调函数
	function queuePreFlushCb(cb) {
		queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex);
	}
	// 刷新后置任务队列的回调函数
	function queuePostFlushCb(cb) {
		queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex);
	}
	// 刷新前置队列
	function flushPreFlushCbs(seen, parentJob = null) {
		if (pendingPreFlushCbs.length) {
			currentPreFlushParentJob = parentJob;
			activePreFlushCbs = [...new Set(pendingPreFlushCbs)];
			// 重置等待中的前置队列
			pendingPreFlushCbs.length = 0;
			{
				seen = seen || new Map();
			}
			for (preFlushIndex = 0; preFlushIndex < activePreFlushCbs.length; preFlushIndex++) {
				{
					checkRecursiveUpdates(seen, activePreFlushCbs[preFlushIndex]);
				}
				activePreFlushCbs[preFlushIndex]();
			}
			// 重置
			activePreFlushCbs = null;
			preFlushIndex = 0;
			currentPreFlushParentJob = null;
			// 递归刷新前置队列，因为pendingPreFlushCbs随时可能会增加
			flushPreFlushCbs(seen, parentJob);
		}
	}
	// 刷新后置队列
	function flushPostFlushCbs(seen) {
		if (pendingPostFlushCbs.length) {
			const deduped = [...new Set(pendingPostFlushCbs)];
			pendingPostFlushCbs.length = 0;
			// 如果后置正在刷新的队列存在，则直接添加到队列中，终止函数
			if (activePostFlushCbs) {
				activePostFlushCbs.push(...deduped);
				return;
			}
			activePostFlushCbs = deduped;
			{
				seen = seen || new Map();
			}
			activePostFlushCbs.sort((a, b) => getId(a) - getId(b));
			for (postFlushIndex = 0; postFlushIndex < activePostFlushCbs.length; postFlushIndex++) {
				{
					checkRecursiveUpdates(seen, activePostFlushCbs[postFlushIndex]);
				}
				activePostFlushCbs[postFlushIndex]();
			}
			activePostFlushCbs = null;
			postFlushIndex = 0;
		}
	}
	const getId = (job) => job.id == null ? Infinity : job.id;
	// 刷新任务
	function flushJobs(seen) {
		isFlushPending = false;
		isFlushing = true;
		{
			seen = seen || new Map();
		}
		// 先刷新前置队列
		flushPreFlushCbs(seen);
		// 将队列排序一下
		queue.sort((a, b) => getId(a) - getId(b));
		try {
			for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
				const job = queue[flushIndex];
				if (job) {
					if (true) {
						checkRecursiveUpdates(seen, job);
					}
					// 触发任务
					callWithErrorHandling(job, null, 14 /* SCHEDULER */);
				}
			}
		}
		finally {
			flushIndex = 0;
			queue.length = 0;
			// 刷新后置队列
			flushPostFlushCbs(seen);
			// 重置
			isFlushing = false;
			currentFlushPromise = null;
			if (queue.length || pendingPostFlushCbs.length) {
				// 递归刷新任务
				flushJobs(seen);
			}
		}
	}
	// 检查递归更新是否大于限制大小
	function checkRecursiveUpdates(seen, fn) {
		if (!seen.has(fn)) {
			seen.set(fn, 1);
		}
		else {
			const count = seen.get(fn);
			if (count > RECURSION_LIMIT) {
				throw new Error(`Maximum recursive updates exceeded. ` +
					`This means you have a reactive effect that is mutating its own ` +
					`dependencies and thus recursively triggering itself. Possible sources ` +
					`include component template, render function, updated hook or ` +
					`watcher source function.`);
			}
			else {
				seen.set(fn, count + 1);
			}
		}
	}

	// 是否为hmr（热替换）更新
	let isHmrUpdating = false;
	// 热替换脏组件集合
	const hmrDirtyComponents = new Set();
	{
		// 全局对象 默认window
		const globalObject = typeof global !== 'undefined'
			? global
			: typeof self !== 'undefined'
				? self
				: typeof window !== 'undefined'
					? window
					: {};
		globalObject.__VUE_HMR_RUNTIME__ = {
			createRecord: tryWrap(createRecord),
			rerender: tryWrap(rerender),
			reload: tryWrap(reload)
		};
	}
	const map = new Map();
	// 注册HMR
	function registerHMR(instance) {
		const id = instance.type.__hmrId;
		let record = map.get(id);
		if (!record) {
			createRecord(id, instance.type);
			record = map.get(id);
		}
		record.instances.add(instance);
	}
	// 卸载HMR
	function unregisterHMR(instance) {
		map.get(instance.type.__hmrId).instances.delete(instance);
	}
	// 创建一个记录
	function createRecord(id, component) {
		if (map.has(id)) {
			return false;
		}
		map.set(id, {
			component: isClassComponent(component) ? component.__vccOpts : component,
			instances: new Set()
		});
		return true;
	}
	// 重新渲染
	function rerender(id, newRender) {
		const record = map.get(id);
		if (!record)
			return;
		if (newRender)
			record.component.render = newRender;
		Array.from(record.instances).forEach(instance => {
			if (newRender) {
				instance.render = newRender;
			}
			instance.renderCache = [];
			isHmrUpdating = true;
			// 触发更新
			instance.update();
			isHmrUpdating = false;
		});
	}
	// 重新加载
	function reload(id, newComp) {
		const record = map.get(id);
		if (!record)
			return;
		const { component, instances } = record;
		if (!hmrDirtyComponents.has(component)) {
			newComp = isClassComponent(newComp) ? newComp.__vccOpts : newComp;
			// 合并新旧组件
			extend(component, newComp);
			// 遍历新旧组件，如果key值在新组件中，则删除旧组件的key值
			for (const key in component) {
				if (!(key in newComp)) {
					delete component[key];
				}
			}
			// 将处理后的组件添加到热替换组件集合中
			hmrDirtyComponents.add(component);
			// 刷新后置队列
			queuePostFlushCb(() => {
				hmrDirtyComponents.delete(component);
			});
		}
		Array.from(instances).forEach(instance => {
			if (instance.parent) {
				// 刷新父组件的队列
				queueJob(instance.parent.update);
			}
			else if (instance.appContext.reload) {
				// 属性app上下文的reload
				instance.appContext.reload();
			}
			else if (typeof window !== 'undefined') {
				window.location.reload();
			}
			else {
				console.warn('[HMR] Root or manually mounted instance modified. Full reload required.');
			}
		});
	}
	// 执行函数包裹try-catch
	function tryWrap(fn) {
		return (id, arg) => {
			try {
				return fn(id, arg);
			}
			catch (e) {
				console.error(e);
				console.warn(`[HMR] Something went wrong during Vue component hot-reload. ` +
					`Full reload required.`);
			}
		};
	}

	// 设置devtool的hook钩子
	function setDevtoolsHook(hook) {
		exports.devtools = hook;
	}
	// devtool初始化app
	function devtoolsInitApp(app, version) {
		if (!exports.devtools)
			return;
		exports.devtools.emit("app:init" /* APP_INIT */, app, version, {
			Fragment,
			Text,
			Comment,
			Static
		});
	}
	// devtool卸载app
	function devtoolsUnmountApp(app) {
		if (!exports.devtools)
			return;
		exports.devtools.emit("app:unmount" /* APP_UNMOUNT */, app);
	}
	// devtool添加组件
	const devtoolsComponentAdded = /*#__PURE__*/ createDevtoolsComponentHook("component:added" /* COMPONENT_ADDED */);
	// devtool更新组件
	const devtoolsComponentUpdated = /*#__PURE__*/ createDevtoolsComponentHook("component:updated" /* COMPONENT_UPDATED */);
	// devtool移除组件
	const devtoolsComponentRemoved = /*#__PURE__*/ createDevtoolsComponentHook("component:removed" /* COMPONENT_REMOVED */);
	// 创建devtool组件的hook钩子
	function createDevtoolsComponentHook(hook) {
		return (component) => {
			if (!exports.devtools)
				return;
			exports.devtools.emit(hook, component.appContext.app, component.uid, component.parent ? component.parent.uid : undefined);
		};
	}
	// devtool组件emit
	function devtoolsComponentEmit(component, event, params) {
		if (!exports.devtools)
			return;
		exports.devtools.emit("component:emit" /* COMPONENT_EMIT */, component.appContext.app, component, event, params);
	}
	/**
	 * VM.$emit
	 * @param {Object} instance 实例
	 * @param {String} event 事件名
	 * @param  {...any} rawArgs 回调arguments
	 * @returns 
	 */
	function emit(instance, event, ...rawArgs) {
		const props = instance.vnode.props || EMPTY_OBJ;
		{
			const { emitsOptions, propsOptions: [propsOptions] } = instance;
			if (emitsOptions) {
				// emit的事件名不在props或emitOptions中
				if (!(event in emitsOptions)) {
					if (!propsOptions || !(toHandlerKey(event) in propsOptions)) {
						warn(`Component emitted event "${event}" but it is neither declared in ` +
							`the emits option nor as an "${toHandlerKey(event)}" prop.`);
					}
				}
				else {
					const validator = emitsOptions[event];
					if (isFunction(validator)) {
						// 触发已注册的事件
						const isValid = validator(...rawArgs);
						if (!isValid) {
							warn(`Invalid event arguments: event validation failed for event "${event}".`);
						}
					}
				}
			}
		}
		let args = rawArgs;
		// 是否为v-model监听的事件
		const isModelListener = event.startsWith('update:');
		// 事件名
		const modelArg = isModelListener && event.slice(7);
		if (modelArg && modelArg in props) {
			// 修饰词
			const modifiersKey = `${modelArg === 'modelValue' ? 'model' : modelArg}Modifiers`;
			const { number, trim } = props[modifiersKey] || EMPTY_OBJ;
			// 去除两边空格
			if (trim) {
				args = rawArgs.map(a => a.trim());
			}
			// 转数值类型
			else if (number) {
				args = rawArgs.map(toNumber);
			}
		}
		{
			devtoolsComponentEmit(instance, event, args);
		}
		{
			const lowerCaseEvent = event.toLowerCase();
			if (lowerCaseEvent !== event && props[toHandlerKey(lowerCaseEvent)]) {
				warn(`Event "${lowerCaseEvent}" is emitted in component ` +
					`${formatComponentName(instance, instance.type)} but the handler is registered for "${event}". ` +
					`Note that HTML attributes are case-insensitive and you cannot use ` +
					`v-on to listen to camelCase events when using in-DOM templates. ` +
					`You should probably use "${hyphenate(event)}" instead of "${event}".`);
			}
		}
		let handlerName = toHandlerKey(camelize(event));
		let handler = props[handlerName];
		if (!handler && isModelListener) {
			handlerName = toHandlerKey(hyphenate(event));
			handler = props[handlerName];
		}
		// 触发事件绑定回调
		if (handler) {
			callWithAsyncErrorHandling(handler, instance, 6 /* COMPONENT_EVENT_HANDLER */, args);
		}
		const onceHandler = props[handlerName + `Once`];
		if (onceHandler) {
			if (!instance.emitted) {
				(instance.emitted = {})[handlerName] = true;
			}
			else if (instance.emitted[handlerName]) {
				return;
			}
			callWithAsyncErrorHandling(onceHandler, instance, 6 /* COMPONENT_EVENT_HANDLER */, args);
		}
	}
	// 格式化emit-options
	function normalizeEmitsOptions(comp, appContext, asMixin = false) {
		// 缓存
		if (!appContext.deopt && comp.__emits !== undefined) {
			return comp.__emits;
		}
		// 子组件可以添加emits对象，和props的注册类似
		const raw = comp.emits;
		let normalized = {};
		let hasExtends = false;
		if (!isFunction(comp)) {
			const extendEmits = (raw) => {
				hasExtends = true;
				extend(normalized, normalizeEmitsOptions(raw, appContext, true));
			};
			// 全局mixin
			if (!asMixin && appContext.mixins.length) {
				appContext.mixins.forEach(extendEmits);
			}
			// 子组件的extends
			if (comp.extends) {
				extendEmits(comp.extends);
			}
			// 子组件的mixins
			if (comp.mixins) {
				comp.mixins.forEach(extendEmits);
			}
		}
		if (!raw && !hasExtends) {
			return (comp.__emits = null);
		}
		if (isArray(raw)) {
			raw.forEach(key => (normalized[key] = null));
		}
		else {
			extend(normalized, raw);
		}
		return (comp.__emits = normalized);
	}
	// 判断事件是否为emit事件
	function isEmitListener(options, key) {
		if (!options || !isOn(key)) {
			return false;
		}
		key = key.replace(/Once$/, '');
		return (hasOwn(options, key[2].toLowerCase() + key.slice(3)) ||
			hasOwn(options, key.slice(2)));
	}

	let currentRenderingInstance = null;
	// 设置当前渲染实例
	function setCurrentRenderingInstance(instance) {
		currentRenderingInstance = instance;
	}
	let accessedAttrs = false;
	// 标记attrs是否可用(access)
	function markAttrsAccessed() {
		accessedAttrs = true;
	}
	// 渲染组件根实例
	function renderComponentRoot(instance) {
		const { type: Component, vnode, proxy, withProxy, props, propsOptions: [propsOptions], slots, attrs, emit, render, renderCache, data, setupState, ctx } = instance;
		let result;
		currentRenderingInstance = instance;
		{
			accessedAttrs = false;
		}
		try {
			let fallthroughAttrs;
			if (vnode.shapeFlag & 4 /* STATEFUL_COMPONENT */) {
				const proxyToUse = withProxy || proxy;
				// 执行render函数 proxyToUse => _ct
				result = normalizeVNode(render.call(proxyToUse, proxyToUse, renderCache, props, setupState, data, ctx));
				fallthroughAttrs = attrs;
			}
			else {
				// functional
				const render = Component;
				// in dev, mark attrs accessed if optional props (attrs === props)
				if (true && attrs === props) {
					markAttrsAccessed();
				}
				result = normalizeVNode(render.length > 1
					? render(props, true
						? {
							get attrs() {
								markAttrsAccessed();
								return attrs;
							},
							slots,
							emit
						}
						: { attrs, slots, emit })
					: render(props, null /* we know it doesn't need it */));
				fallthroughAttrs = Component.props
					? attrs
					: getFunctionalFallthrough(attrs);
			}
			// attr merging
			// in dev mode, comments are preserved, and it's possible for a template
			// to have comments along side the root element which makes it a fragment
			let root = result;
			let setRoot = undefined;
			if (true) {
				;
				[root, setRoot] = getChildRoot(result);
			}
			if (Component.inheritAttrs !== false && fallthroughAttrs) {
				const keys = Object.keys(fallthroughAttrs);
				const { shapeFlag } = root;
				if (keys.length) {
					if (shapeFlag & 1 /* ELEMENT */ ||
						shapeFlag & 6 /* COMPONENT */) {
						if (propsOptions && keys.some(isModelListener)) {
							// If a v-model listener (onUpdate:xxx) has a corresponding declared
							// prop, it indicates this component expects to handle v-model and
							// it should not fallthrough.
							// related: #1543, #1643, #1989
							fallthroughAttrs = filterModelListeners(fallthroughAttrs, propsOptions);
						}
						root = cloneVNode(root, fallthroughAttrs);
					}
					else if (true && !accessedAttrs && root.type !== Comment) {
						const allAttrs = Object.keys(attrs);
						const eventAttrs = [];
						const extraAttrs = [];
						for (let i = 0, l = allAttrs.length; i < l; i++) {
							const key = allAttrs[i];
							if (isOn(key)) {
								// ignore v-model handlers when they fail to fallthrough
								if (!isModelListener(key)) {
									// remove `on`, lowercase first letter to reflect event casing
									// accurately
									eventAttrs.push(key[2].toLowerCase() + key.slice(3));
								}
							}
							else {
								extraAttrs.push(key);
							}
						}
						if (extraAttrs.length) {
							warn(`Extraneous non-props attributes (` +
								`${extraAttrs.join(', ')}) ` +
								`were passed to component but could not be automatically inherited ` +
								`because component renders fragment or text root nodes.`);
						}
						if (eventAttrs.length) {
							warn(`Extraneous non-emits event listeners (` +
								`${eventAttrs.join(', ')}) ` +
								`were passed to component but could not be automatically inherited ` +
								`because component renders fragment or text root nodes. ` +
								`If the listener is intended to be a component custom event listener only, ` +
								`declare it using the "emits" option.`);
						}
					}
				}
			}
			// 继承自定义指令
			if (vnode.dirs) {
				if (true && !isElementRoot(root)) {
					warn(`Runtime directive used on component with non-element root node. ` +
						`The directives will not function as intended.`);
				}
				root.dirs = root.dirs ? root.dirs.concat(vnode.dirs) : vnode.dirs;
			}
			// 继承transition
			if (vnode.transition) {
				if (true && !isElementRoot(root)) {
					warn(`Component inside <Transition> renders non-element root node ` +
						`that cannot be animated.`);
				}
				root.transition = vnode.transition;
			}
			if (true && setRoot) {
				// 设置根标签
				setRoot(root);
			}
			else {
				result = root;
			}
		}
		catch (err) {
			handleError(err, instance, 1 /* RENDER_FUNCTION */);
			result = createVNode(Comment);
		}
		currentRenderingInstance = null;
		return result;
	}
	// 获取子节点的根
	const getChildRoot = (vnode) => {
		if (vnode.type !== Fragment) {
			return [vnode, undefined];
		}
		const rawChildren = vnode.children;
		const dynamicChildren = vnode.dynamicChildren;
		const childRoot = filterSingleRoot(rawChildren);
		if (!childRoot) {
			return [vnode, undefined];
		}
		const index = rawChildren.indexOf(childRoot);
		const dynamicIndex = dynamicChildren ? dynamicChildren.indexOf(childRoot) : -1;
		const setRoot = (updatedRoot) => {
			rawChildren[index] = updatedRoot;
			if (dynamicChildren) {
				if (dynamicIndex > -1) {
					dynamicChildren[dynamicIndex] = updatedRoot;
				}
				else if (updatedRoot.patchFlag > 0) {
					vnode.dynamicChildren = [...dynamicChildren, updatedRoot];
				}
			}
		};
		return [normalizeVNode(childRoot), setRoot];
	};
	/**
	 * 筛选子节点列表中的第一项
	 */
	function filterSingleRoot(children) {
		const filtered = children.filter(child => {
			return !(isVNode(child) &&
				child.type === Comment &&
				child.children !== 'v-if');
		});
		return filtered.length === 1 && isVNode(filtered[0]) ? filtered[0] : null;
	}
	// 获取class、style、事件类型的属性
	const getFunctionalFallthrough = (attrs) => {
		let res;
		for (const key in attrs) {
			if (key === 'class' || key === 'style' || isOn(key)) {
				(res || (res = {}))[key] = attrs[key];
			}
		}
		return res;
	};
	// 过滤掉v-model绑定的事件属性
	const filterModelListeners = (attrs, props) => {
		const res = {};
		for (const key in attrs) {
			if (!isModelListener(key) || !(key.slice(9) in props)) {
				res[key] = attrs[key];
			}
		}
		return res;
	};
	// 是否为Element根节点
	const isElementRoot = (vnode) => {
		return (vnode.shapeFlag & 6 /* COMPONENT */ ||
			vnode.shapeFlag & 1 /* ELEMENT */ ||
			vnode.type === Comment // potential v-if branch switch
		);
	};
	// 是否需要更新组件
	function shouldUpdateComponent(prevVNode, nextVNode, optimized) {
		const { props: prevProps, children: prevChildren, component } = prevVNode;
		const { props: nextProps, children: nextChildren, patchFlag } = nextVNode;
		const emits = component.emitsOptions;
		if ((prevChildren || nextChildren) && isHmrUpdating) {
			return true;
		}
		// 新节点有自定义指令或者是transition组件，返回true
		if (nextVNode.dirs || nextVNode.transition) {
			return true;
		}
		if (optimized && patchFlag >= 0) {
			if (patchFlag & 1024 /* DYNAMIC_SLOTS */) {
				// 动态插槽内容
				// e.g. in a v-for
				return true;
			}
			if (patchFlag & 16 /* FULL_PROPS */) {
				if (!prevProps) {
					return !!nextProps;
				}
				// presence of this flag indicates props are always non-null
				return hasPropsChanged(prevProps, nextProps, emits);
			}
			else if (patchFlag & 8 /* PROPS */) {
				const dynamicProps = nextVNode.dynamicProps;
				for (let i = 0; i < dynamicProps.length; i++) {
					const key = dynamicProps[i];
					if (nextProps[key] !== prevProps[key] &&
						!isEmitListener(emits, key)) {
						return true;
					}
				}
			}
		}
		else {
			// this path is only taken by manually written render functions
			// so presence of any children leads to a forced update
			if (prevChildren || nextChildren) {
				if (!nextChildren || !nextChildren.$stable) {
					return true;
				}
			}
			if (prevProps === nextProps) {
				return false;
			}
			if (!prevProps) {
				return !!nextProps;
			}
			if (!nextProps) {
				return true;
			}
			return hasPropsChanged(prevProps, nextProps, emits);
		}
		return false;
	}
	// props是否有改变
	function hasPropsChanged(prevProps, nextProps, emitsOptions) {
		const nextKeys = Object.keys(nextProps);
		if (nextKeys.length !== Object.keys(prevProps).length) {
			return true;
		}
		for (let i = 0; i < nextKeys.length; i++) {
			const key = nextKeys[i];
			if (nextProps[key] !== prevProps[key] &&
				!isEmitListener(emitsOptions, key)) {
				return true;
			}
		}
		return false;
	}
	// 更新高阶组件的父元素的element
	function updateHOCHostEl({ vnode, parent }, el) {
		while (parent && parent.subTree === vnode) {
			(vnode = parent.vnode).el = el;
			parent = parent.parent;
		}
	}

	// 判断组件是否为suspense组件
	const isSuspense = (type) => type.__isSuspense;
	// suspense会暂停你的组件渲染，并重现一个回落组件，直到满足一个条件
	const SuspenseImpl = {
		__isSuspense: true,
		process(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized,
			rendererInternals) {
			if (n1 == null) {
				mountSuspense(n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized, rendererInternals);
			}
			else {
				patchSuspense(n1, n2, container, anchor, parentComponent, isSVG, rendererInternals);
			}
		},
		hydrate: hydrateSuspense,
		create: createSuspenseBoundary
	};
	const Suspense = (SuspenseImpl);
	// 挂载suspense组件
	function mountSuspense(vnode, container, anchor, parentComponent, parentSuspense, isSVG, optimized, rendererInternals) {
		const { p: patch, o: { createElement } } = rendererInternals;
		// 隐藏容器
		const hiddenContainer = createElement('div');
		const suspense = (vnode.suspense = createSuspenseBoundary(vnode, parentSuspense, parentComponent, container, hiddenContainer, anchor, isSVG, optimized, rendererInternals));
		patch(null, (suspense.pendingBranch = vnode.ssContent), hiddenContainer, null, parentComponent, suspense, isSVG);
		if (suspense.deps > 0) {
			// 异步
			patch(null, vnode.ssFallback, container, anchor, parentComponent, null, // fallback tree will not have suspense context
				isSVG);
			setActiveBranch(suspense, vnode.ssFallback);
		}
		else {
			// 解析suspense
			suspense.resolve();
		}
	}
	// 修补suspense组件
	function patchSuspense(n1, n2, container, anchor, parentComponent, isSVG, { p: patch, um: unmount, o: { createElement } }) {
		const suspense = (n2.suspense = n1.suspense);
		suspense.vnode = n2;
		n2.el = n1.el;
		const newBranch = n2.ssContent;
		const newFallback = n2.ssFallback;
		const { activeBranch, pendingBranch, isInFallback, isHydrating } = suspense;
		if (pendingBranch) {
			suspense.pendingBranch = newBranch;
			if (isSameVNodeType(newBranch, pendingBranch)) {
				// 
				patch(pendingBranch, newBranch, suspense.hiddenContainer, null, parentComponent, suspense, isSVG);
				if (suspense.deps <= 0) {
					suspense.resolve();
				}
				else if (isInFallback) {
					patch(activeBranch, newFallback, container, anchor, parentComponent, null, // fallback tree will not have suspense context
						isSVG);
					setActiveBranch(suspense, newFallback);
				}
			}
			else {
				// toggled before pending tree is resolved
				suspense.pendingId++;
				if (isHydrating) {
					// if toggled before hydration is finished, the current DOM tree is
					// no longer valid. set it as the active branch so it will be unmounted
					// when resolved
					suspense.isHydrating = false;
					suspense.activeBranch = pendingBranch;
				}
				else {
					unmount(pendingBranch, parentComponent, suspense);
				}
				// increment pending ID. this is used to invalidate async callbacks
				// reset suspense state
				suspense.deps = 0;
				// discard effects from pending branch
				suspense.effects.length = 0;
				// discard previous container
				suspense.hiddenContainer = createElement('div');
				if (isInFallback) {
					// already in fallback state
					patch(null, newBranch, suspense.hiddenContainer, null, parentComponent, suspense, isSVG);
					if (suspense.deps <= 0) {
						suspense.resolve();
					}
					else {
						patch(activeBranch, newFallback, container, anchor, parentComponent, null, // fallback tree will not have suspense context
							isSVG);
						setActiveBranch(suspense, newFallback);
					}
				}
				else if (activeBranch && isSameVNodeType(newBranch, activeBranch)) {
					// toggled "back" to current active branch
					patch(activeBranch, newBranch, container, anchor, parentComponent, suspense, isSVG);
					// force resolve
					suspense.resolve(true);
				}
				else {
					// switched to a 3rd branch
					patch(null, newBranch, suspense.hiddenContainer, null, parentComponent, suspense, isSVG);
					if (suspense.deps <= 0) {
						suspense.resolve();
					}
				}
			}
		}
		else {
			if (activeBranch && isSameVNodeType(newBranch, activeBranch)) {
				// 新旧节点没有改变，正常patch
				patch(activeBranch, newBranch, container, anchor, parentComponent, suspense, isSVG);
				setActiveBranch(suspense, newBranch);
			}
			else {
				// onPending hook
				const onPending = n2.props && n2.props.onPending;
				if (isFunction(onPending)) {
					onPending();
				}
				// 赋值等待中的分支
				suspense.pendingBranch = newBranch;
				suspense.pendingId++;
				patch(null, newBranch, suspense.hiddenContainer, null, parentComponent, suspense, isSVG);
				if (suspense.deps <= 0) {
					// 没有异步解析，直接resolve
					suspense.resolve();
				}
				else {
					const { timeout, pendingId } = suspense;
					if (timeout > 0) {
						setTimeout(() => {
							if (suspense.pendingId === pendingId) {
								suspense.fallback(newFallback);
							}
						}, timeout);
					}
					else if (timeout === 0) {
						suspense.fallback(newFallback);
					}
				}
			}
		}
	}
	let hasWarned = false;
	// 创建suspense组件分界
	function createSuspenseBoundary(vnode, parent, parentComponent, container, hiddenContainer, anchor, isSVG, optimized, rendererInternals, isHydrating = false) {
		if (!hasWarned) {
			hasWarned = true;
			console[console.info ? 'info' : 'log'](`<Suspense> is an experimental feature and its API will likely change.`);
		}
		const { p: patch, m: move, um: unmount, n: next, o: { parentNode, remove } } = rendererInternals;
		const timeout = toNumber(vnode.props && vnode.props.timeout);
		const suspense = {
			vnode,
			parent,
			parentComponent,
			isSVG,
			container,
			hiddenContainer,
			anchor,
			deps: 0,
			pendingId: 0,
			timeout: typeof timeout === 'number' ? timeout : -1,
			activeBranch: null,
			pendingBranch: null,
			isInFallback: true,
			isHydrating,
			isUnmounted: false,
			effects: [],
			resolve(resume = false) {
				{
					if (!resume && !suspense.pendingBranch) {
						throw new Error(`suspense.resolve() is called without a pending branch.`);
					}
					if (suspense.isUnmounted) {
						throw new Error(`suspense.resolve() is called on an already unmounted suspense boundary.`);
					}
				}
				const { vnode, activeBranch, pendingBranch, pendingId, effects, parentComponent, container } = suspense;
				if (suspense.isHydrating) {
					suspense.isHydrating = false;
				}
				else if (!resume) {
					// 延迟进入
					const delayEnter = activeBranch &&
						pendingBranch.transition &&
						pendingBranch.transition.mode === 'out-in';
					if (delayEnter) {
						activeBranch.transition.afterLeave = () => {
							if (pendingId === suspense.pendingId) {
								move(pendingBranch, container, anchor, 0 /* ENTER */);
							}
						};
					}
					let { anchor } = suspense;
					if (activeBranch) {
						anchor = next(activeBranch);
						unmount(activeBranch, parentComponent, suspense, true);
					}
					if (!delayEnter) {
						// 移动
						move(pendingBranch, container, anchor, 0 /* ENTER */);
					}
				}
				setActiveBranch(suspense, pendingBranch);
				suspense.pendingBranch = null;
				suspense.isInFallback = false;
				let parent = suspense.parent;
				// 是否有未解析的锚点
				let hasUnresolvedAncestor = false;
				while (parent) {
					if (parent.pendingBranch) {
						parent.effects.push(...effects);
						hasUnresolvedAncestor = true;
						break;
					}
					parent = parent.parent;
				}
				if (!hasUnresolvedAncestor) {
					queuePostFlushCb(effects);
				}
				suspense.effects = [];
				const onResolve = vnode.props && vnode.props.onResolve;
				if (isFunction(onResolve)) {
					onResolve();
				}
			},
			fallback(fallbackVNode) {
				if (!suspense.pendingBranch) {
					return;
				}
				const { vnode, activeBranch, parentComponent, container, isSVG } = suspense;
				// onFallback钩子
				const onFallback = vnode.props && vnode.props.onFallback;
				if (isFunction(onFallback)) {
					onFallback();
				}
				const anchor = next(activeBranch);
				const mountFallback = () => {
					if (!suspense.isInFallback) {
						return;
					}
					// 修补回调函数返回的vnode
					patch(null, fallbackVNode, container, anchor, parentComponent, null, // fallback tree will not have suspense context
						isSVG);
					setActiveBranch(suspense, fallbackVNode);
				};
				// 延迟进入
				const delayEnter = fallbackVNode.transition && fallbackVNode.transition.mode === 'out-in';
				if (delayEnter) {
					activeBranch.transition.afterLeave = mountFallback;
				}
				// 卸载活跃的分支
				unmount(activeBranch, parentComponent, null, // no suspense so unmount hooks fire now
					true // shouldRemove
				);
				suspense.isInFallback = true;
				if (!delayEnter) {
					mountFallback();
				}
			},
			// 移动分支到容器中
			move(container, anchor, type) {
				suspense.activeBranch &&
					move(suspense.activeBranch, container, anchor, type);
				suspense.container = container;
			},
			next() {
				return suspense.activeBranch && next(suspense.activeBranch);
			},
			// 注册dep
			registerDep(instance, setupRenderEffect) {
				if (!suspense.pendingBranch) {
					return;
				}
				const hydratedEl = instance.vnode.el;
				suspense.deps++;
				instance
					.asyncDep.catch(err => {
						handleError(err, instance, 0 /* SETUP_FUNCTION */);
					})
					.then(asyncSetupResult => {
						if (instance.isUnmounted ||
							suspense.isUnmounted ||
							suspense.pendingId !== instance.suspenseId) {
							return;
						}
						suspense.deps--;
						// retry from this component
						instance.asyncResolved = true;
						const { vnode } = instance;
						{
							pushWarningContext(vnode);
						}
						handleSetupResult(instance, asyncSetupResult);
						if (hydratedEl) {
							vnode.el = hydratedEl;
						}
						const placeholder = !hydratedEl && instance.subTree.el;
						setupRenderEffect(instance, vnode,
							parentNode(hydratedEl || instance.subTree.el),
							hydratedEl ? null : next(instance.subTree), suspense, isSVG, optimized);
						if (placeholder) {
							remove(placeholder);
						}
						updateHOCHostEl(instance, vnode.el);
						{
							popWarningContext();
						}
						if (suspense.deps === 0) {
							suspense.resolve();
						}
					});
			},
			unmount(parentSuspense, doRemove) {
				suspense.isUnmounted = true;
				if (suspense.activeBranch) {
					unmount(suspense.activeBranch, parentComponent, parentSuspense, doRemove);
				}
				if (suspense.pendingBranch) {
					unmount(suspense.pendingBranch, parentComponent, parentSuspense, doRemove);
				}
			}
		};
		return suspense;
	}
	function hydrateSuspense(node, vnode, parentComponent, parentSuspense, isSVG, optimized, rendererInternals, hydrateNode) {
		/* eslint-disable no-restricted-globals */
		const suspense = (vnode.suspense = createSuspenseBoundary(vnode, parentSuspense, parentComponent, node.parentNode, document.createElement('div'), null, isSVG, optimized, rendererInternals, true /* hydrating */));
		// there are two possible scenarios for server-rendered suspense:
		// - success: ssr content should be fully resolved
		// - failure: ssr content should be the fallback branch.
		// however, on the client we don't really know if it has failed or not
		// attempt to hydrate the DOM assuming it has succeeded, but we still
		// need to construct a suspense boundary first
		const result = hydrateNode(node, (suspense.pendingBranch = vnode.ssContent), parentComponent, suspense, optimized);
		if (suspense.deps === 0) {
			suspense.resolve();
		}
		return result;
	}
	// 格式化suspense子节点
	function normalizeSuspenseChildren(vnode) {
		const { shapeFlag, children } = vnode;
		let content;
		let fallback;
		if (shapeFlag & 32 /* SLOTS_CHILDREN */) {
			// 插槽内容
			content = normalizeSuspenseSlot(children.default);
			fallback = normalizeSuspenseSlot(children.fallback);
		}
		else {
			content = normalizeSuspenseSlot(children);
			fallback = normalizeVNode(null);
		}
		return {
			content,
			fallback
		};
	}
	// 格式化suspense组件插槽内容
	function normalizeSuspenseSlot(s) {
		if (isFunction(s)) {
			// 插槽内容
			s = s();
		}
		if (isArray(s)) {
			// 单子节点
			const singleChild = filterSingleRoot(s);
			if (!singleChild) {
				warn(`<Suspense> slots expect a single root node.`);
			}
			s = singleChild;
		}
		return normalizeVNode(s);
	}
	// 刷新任务队列，支持suspense组件
	function queueEffectWithSuspense(fn, suspense) {
		if (suspense && suspense.pendingBranch) {
			if (isArray(fn)) {
				suspense.effects.push(...fn);
			}
			else {
				suspense.effects.push(fn);
			}
		}
		else {
			queuePostFlushCb(fn);
		}
	}
	// 设置当前活跃的分支
	function setActiveBranch(suspense, branch) {
		suspense.activeBranch = branch;
		const { vnode, parentComponent } = suspense;
		const el = (vnode.el = branch.el);
		if (parentComponent && parentComponent.subTree === vnode) {
			parentComponent.vnode.el = el;
			updateHOCHostEl(parentComponent, el);
		}
	}

	let isRenderingCompiledSlot = 0;
	const setCompiledSlotRendering = (n) => (isRenderingCompiledSlot += n);
	/**
	 * 渲染插槽
	 * @private
	 */
	function renderSlot(slots, name, props = {},
		fallback) {
		let slot = slots[name];
		if (slot && slot.length > 1) {
			warn(`SSR-optimized slot function detected in a non-SSR-optimized render ` +
				`function. You need to mark this component with $dynamic-slots in the ` +
				`parent template.`);
			slot = () => [];
		}
		isRenderingCompiledSlot++;
		const rendered = (openBlock(),
			createBlock(Fragment, { key: props.key }, slot ? slot(props) : fallback ? fallback() : [], slots._ === 1 /* STABLE */
				? 64 /* STABLE_FRAGMENT */
				: -2 /* BAIL */));
		isRenderingCompiledSlot--;
		return rendered;
	}

	/**
	 * 支持上下文
	 * @private
	 */
	function withCtx(fn, ctx = currentRenderingInstance) {
		if (!ctx)
			return fn;
		const renderFnWithContext = (...args) => {
			if (!isRenderingCompiledSlot) {
				openBlock(true /* null block that disables tracking */);
			}
			const owner = currentRenderingInstance;
			setCurrentRenderingInstance(ctx);
			const res = fn(...args);
			setCurrentRenderingInstance(owner);
			if (!isRenderingCompiledSlot) {
				closeBlock();
			}
			return res;
		};
		renderFnWithContext._c = true;
		return renderFnWithContext;
	}
	// 当前作用域ID
	let currentScopeId = null;
	// 作用域ID栈
	const scopeIdStack = [];
	/**
	 * 添加作用域ID
	 * @private
	 */
	function pushScopeId(id) {
		scopeIdStack.push((currentScopeId = id));
	}
	/**
	 * 移除作用域ID
	 * @private
	 */
	function popScopeId() {
		scopeIdStack.pop();
		currentScopeId = scopeIdStack[scopeIdStack.length - 1] || null;
	}
	/**
	 * 支持作用域ID
	 * @private
	 */
	function withScopeId(id) {
		return ((fn) => withCtx(function () {
			pushScopeId(id);
			const res = fn.apply(this, arguments);
			popScopeId();
			return res;
		}));
	}

	// 初始化props
	function initProps(instance, rawProps, isStateful, // 按位标记比较的结果，是否为有状态组件
		isSSR = false) {
		const props = {};
		const attrs = {};
		// 标记attrs为内置的对象
		def(attrs, InternalObjectKey, 1);
		setFullProps(instance, rawProps, props, attrs);
		// validation
		{
			validateProps(props, instance);
		}
		if (isStateful) {
			// stateful
			instance.props = isSSR ? props : shallowReactive(props);
		}
		else {
			if (!instance.type.props) {
				// functional w/ optional props, props === attrs
				instance.props = attrs;
			}
			else {
				// functional w/ declared props
				instance.props = props;
			}
		}
		instance.attrs = attrs;
	}
	// 更新props
	function updateProps(instance, rawProps, rawPrevProps, optimized) {
		const { props, attrs, vnode: { patchFlag } } = instance;
		const rawCurrentProps = toRaw(props);
		const [options] = instance.propsOptions;
		if (
			!(
				(instance.type.__hmrId ||
					(instance.parent && instance.parent.type.__hmrId))) &&
			(optimized || patchFlag > 0) &&
			!(patchFlag & 16 /* FULL_PROPS */)) {
			if (patchFlag & 8 /* PROPS */) {
				// Compiler-generated props & no keys change, just set the updated
				// the props.
				const propsToUpdate = instance.vnode.dynamicProps;
				for (let i = 0; i < propsToUpdate.length; i++) {
					const key = propsToUpdate[i];
					// PROPS flag guarantees rawProps to be non-null
					const value = rawProps[key];
					if (options) {
						// attr / props separation was done on init and will be consistent
						// in this code path, so just check if attrs have it.
						if (hasOwn(attrs, key)) {
							attrs[key] = value;
						}
						else {
							const camelizedKey = camelize(key);
							props[camelizedKey] = resolvePropValue(options, rawCurrentProps, camelizedKey, value, instance);
						}
					}
					else {
						attrs[key] = value;
					}
				}
			}
		}
		else {
			// full props update.
			setFullProps(instance, rawProps, props, attrs);
			// in case of dynamic props, check if we need to delete keys from
			// the props object
			let kebabKey;
			for (const key in rawCurrentProps) {
				if (!rawProps ||
					// for camelCase
					(!hasOwn(rawProps, key) &&
						// it's possible the original props was passed in as kebab-case
						// and converted to camelCase (#955)
						((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey)))) {
					if (options) {
						if (rawPrevProps &&
							// for camelCase
							(rawPrevProps[key] !== undefined ||
								// for kebab-case
								rawPrevProps[kebabKey] !== undefined)) {
							props[key] = resolvePropValue(options, rawProps || EMPTY_OBJ, key, undefined, instance);
						}
					}
					else {
						delete props[key];
					}
				}
			}
			// in the case of functional component w/o props declaration, props and
			// attrs point to the same object so it should already have been updated.
			if (attrs !== rawCurrentProps) {
				for (const key in attrs) {
					if (!rawProps || !hasOwn(rawProps, key)) {
						delete attrs[key];
					}
				}
			}
		}
		// trigger updates for $attrs in case it's used in component slots
		trigger(instance, "set" /* SET */, '$attrs');
		if (rawProps) {
			validateProps(props, instance);
		}
	}
	function setFullProps(instance, rawProps, props, attrs) {
		const [options, needCastKeys] = instance.propsOptions;
		if (rawProps) {
			for (const key in rawProps) {
				const value = rawProps[key];
				// key, ref are reserved and never passed down
				if (isReservedProp(key)) {
					continue;
				}
				// prop option names are camelized during normalization, so to support
				// kebab -> camel conversion here we need to camelize the key.
				let camelKey;
				if (options && hasOwn(options, (camelKey = camelize(key)))) {
					props[camelKey] = value;
				}
				else if (!isEmitListener(instance.emitsOptions, key)) {
					// Any non-declared (either as a prop or an emitted event) props are put
					// into a separate `attrs` object for spreading. Make sure to preserve
					// original key casing
					attrs[key] = value;
				}
			}
		}
		if (needCastKeys) {
			const rawCurrentProps = toRaw(props);
			for (let i = 0; i < needCastKeys.length; i++) {
				const key = needCastKeys[i];
				props[key] = resolvePropValue(options, rawCurrentProps, key, rawCurrentProps[key], instance);
			}
		}
	}
	function resolvePropValue(options, props, key, value, instance) {
		const opt = options[key];
		if (opt != null) {
			const hasDefault = hasOwn(opt, 'default');
			// default values
			if (hasDefault && value === undefined) {
				const defaultValue = opt.default;
				if (opt.type !== Function && isFunction(defaultValue)) {
					setCurrentInstance(instance);
					value = defaultValue(props);
					setCurrentInstance(null);
				}
				else {
					value = defaultValue;
				}
			}
			// boolean casting
			if (opt[0 /* shouldCast */]) {
				if (!hasOwn(props, key) && !hasDefault) {
					value = false;
				}
				else if (opt[1 /* shouldCastTrue */] &&
					(value === '' || value === hyphenate(key))) {
					value = true;
				}
			}
		}
		return value;
	}
	// 格式化props
	function normalizePropsOptions(comp, appContext, asMixin = false) {
		if (!appContext.deopt /* 是否含有mixin */ && comp.__props) {
			return comp.__props;
		}
		const raw = comp.props;
		const normalized = {};
		const needCastKeys = [];
		let hasExtends = false;
		if (!isFunction(comp)) {
			const extendProps = (raw) => {
				hasExtends = true;
				const [props, keys] = normalizePropsOptions(raw, appContext, true);
				extend(normalized, props);
				if (keys)
					needCastKeys.push(...keys);
			};
			// 全局mixin
			if (!asMixin && appContext.mixins.length) {
				appContext.mixins.forEach(extendProps);
			}
			// extends
			if (comp.extends) {
				extendProps(comp.extends);
			}
			// 组件mixin
			if (comp.mixins) {
				comp.mixins.forEach(extendProps);
			}
		}
		if (!raw && !hasExtends) {
			// 默认返回空数组
			return (comp.__props = EMPTY_ARR);
		}
		if (isArray(raw)) {
			// props为数组
			for (let i = 0; i < raw.length; i++) {
				if (!isString(raw[i])) {
					warn(`props must be strings when using array syntax.`, raw[i]);
				}
				const normalizedKey = camelize(raw[i]);
				if (validatePropName(normalizedKey)) {
					normalized[normalizedKey] = EMPTY_OBJ;
				}
			}
		}
		else if (raw) {
			if (!isObject(raw)) {
				warn(`invalid props options`, raw);
			}
			for (const key in raw) {
				const normalizedKey = camelize(key);
				if (validatePropName(normalizedKey)) {
					const opt = raw[key];
					// 属性值为数组 => { type: [] }
					// 属性值为函数 => fn
					const prop = (normalized[normalizedKey] =
						isArray(opt) || isFunction(opt) ? { type: opt } : opt);
					if (prop) {
						const booleanIndex = getTypeIndex(Boolean, prop.type);
						const stringIndex = getTypeIndex(String, prop.type);
						prop[0 /* shouldCast */] = booleanIndex > -1;
						prop[1 /* shouldCastTrue */] =
							stringIndex < 0 || booleanIndex < stringIndex;
						if (booleanIndex > -1 || hasOwn(prop, 'default')) {
							// 元素prop的type为Boolean类型时，或者有default默认值时
							needCastKeys.push(normalizedKey);
						}
					}
				}
			}
		}
		return (comp.__props = [normalized, needCastKeys]);
	}
	// 校验prop名称
	function validatePropName(key) {
		if (key[0] !== '$') {
			return true;
		}
		else {
			warn(`Invalid prop name: "${key}" is a reserved property.`);
		}
		return false;
	}
	// 获取构造器的原型
	function getType(ctor) {
		const match = ctor && ctor.toString().match(/^\s*function (\w+)/);
		return match ? match[1] : '';
	}
	// 判断类型是否相等
	function isSameType(a, b) {
		return getType(a) === getType(b);
	}
	// 获取指定类型在数组中的索引
	function getTypeIndex(type, expectedTypes) {
		if (isArray(expectedTypes)) {
			for (let i = 0, len = expectedTypes.length; i < len; i++) {
				if (isSameType(expectedTypes[i], type)) {
					return i;
				}
			}
		}
		else if (isFunction(expectedTypes)) {
			return isSameType(expectedTypes, type) ? 0 : -1;
		}
		return -1;
	}
	// 校验props的合法性
	function validateProps(props, instance) {
		const rawValues = toRaw(props);
		const options = instance.propsOptions[0];
		for (const key in options) {
			let opt = options[key];
			if (opt == null)
				continue;
			validateProp(key, rawValues[key], opt, !hasOwn(rawValues, key));
		}
	}
	// 校验每一个prop
	function validateProp(name, value, prop, isAbsent /* 是否为原型上的属性 */) {
		const { type, required, validator } = prop;
		if (required && isAbsent) { // required prop是否为必输
			warn('Missing required prop: "' + name + '"');
			return;
		}
		if (value == null && !prop.required) {
			return;
		}
		// 检查prop类型
		if (type != null && type !== true) {
			let isValid = false;
			const types = isArray(type) ? type : [type];
			const expectedTypes = [];
			for (let i = 0; i < types.length && !isValid; i++) {
				const { valid, expectedType } = assertType(value, types[i]);
				expectedTypes.push(expectedType || '');
				isValid = valid;
			}
			if (!isValid) {
				warn(getInvalidTypeMessage(name, value, expectedTypes));
				return;
			}
		}
		// 自定义校验类型
		if (validator && !validator(value)) {
			warn('Invalid prop: custom validator check failed for prop "' + name + '".');
		}
	}
	// 是否为简单数据类型
	const isSimpleType = /*#__PURE__*/ makeMap('String,Number,Boolean,Function,Symbol');
	// 断言类型
	function assertType(value, type) {
		let valid;
		// 期待类型
		const expectedType = getType(type);
		if (isSimpleType(expectedType)) {
			const t = typeof value;
			valid = t === expectedType.toLowerCase();
			if (!valid && t === 'object') {
				// 如果期待类型为简单数据类型，但是值为object类型
				valid = value instanceof type;
			}
		}
		else if (expectedType === 'Object') {
			valid = isObject(value);
		}
		else if (expectedType === 'Array') {
			valid = isArray(value);
		}
		else {
			valid = value instanceof type;
		}
		return {
			valid,
			expectedType
		};
	}
	// 获取无效类型提示信息
	function getInvalidTypeMessage(name, value, expectedTypes) {
		let message = `Invalid prop: type check failed for prop "${name}".` +
			` Expected ${expectedTypes.map(capitalize).join(', ')}`;
		const expectedType = expectedTypes[0];
		const receivedType = toRawType(value);
		const expectedValue = styleValue(value, expectedType);
		const receivedValue = styleValue(value, receivedType);
		if (expectedTypes.length === 1 &&
			isExplicable(expectedType) &&
			!isBoolean(expectedType, receivedType)) {
			message += ` with value ${expectedValue}`;
		}
		message += `, got ${receivedType} `;
		if (isExplicable(receivedType)) {
			message += `with value ${receivedValue}.`;
		}
		return message;
	}
	// 格式化value
	function styleValue(value, type) {
		if (type === 'String') {
			// 如果为String类型，则将value转成String类型
			return `"${value}"`;
		}
		else if (type === 'Number') {
			// 如果为Number类型，则将value转成Number类型
			return `${Number(value)}`;
		}
		else {
			return `${value}`;
		}
	}
	// 是否为基本数据类型
	function isExplicable(type) {
		const explicitTypes = ['string', 'number', 'boolean'];
		return explicitTypes.some(elem => type.toLowerCase() === elem);
	}
	// 判断传入参数是否有Boolean类型
	function isBoolean(...args) {
		return args.some(elem => elem.toLowerCase() === 'boolean');
	}
	// 注入hook
	function injectHook(type, hook, target = currentInstance, prepend = false) {
		if (target) {
			// 程序员传递的hooks
			const hooks = target[type] || (target[type] = []);
			const wrappedHook = hook.__weh ||
				(hook.__weh = (...args) => {
					if (target.isUnmounted) {
						return;
					}
					pauseTracking();
					setCurrentInstance(target);
					// 触发已注入的钩子
					const res = callWithAsyncErrorHandling(hook, target, type, args);
					setCurrentInstance(null);
					resetTracking();
					return res;
				});
			if (prepend) {
				// 前置注入
				hooks.unshift(wrappedHook);
			}
			else {
				hooks.push(wrappedHook);
			}
			return wrappedHook;
		}
		else {
			const apiName = toHandlerKey(ErrorTypeStrings[type].replace(/ hook$/, ''));
			warn(`${apiName} is called when there is no active component instance to be ` +
				`associated with. ` +
				`Lifecycle injection APIs can only be used during execution of setup().` +
				(` If you are using async setup(), make sure to register lifecycle ` +
					`hooks before the first await statement.`
				));
		}
	}
	const createHook = (lifecycle) => (hook, target = currentInstance) =>
		!isInSSRComponentSetup && injectHook(lifecycle, hook, target);
	const onBeforeMount = createHook("bm" /* BEFORE_MOUNT */);
	const onMounted = createHook("m" /* MOUNTED */);
	const onBeforeUpdate = createHook("bu" /* BEFORE_UPDATE */);
	const onUpdated = createHook("u" /* UPDATED */);
	const onBeforeUnmount = createHook("bum" /* BEFORE_UNMOUNT */);
	const onUnmounted = createHook("um" /* UNMOUNTED */);
	const onRenderTriggered = createHook("rtg" /* RENDER_TRIGGERED */);
	const onRenderTracked = createHook("rtc" /* RENDER_TRACKED */);
	const onErrorCaptured = (hook, target = currentInstance) => {
		injectHook("ec" /* ERROR_CAPTURED */, hook, target);
	};

	// 简单的watch
	function watchEffect(effect, options) {
		return doWatch(effect, null, options);
	}
	const INITIAL_WATCHER_VALUE = {};
	// watch方法
	function watch(source, cb, options) {
		if (!isFunction(cb)) {
			warn(`\`watch(fn, options?)\` signature has been moved to a separate API. ` +
				`Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
				`supports \`watch(source, cb, options?) signature.`);
		}
		return doWatch(source, cb, options);
	}
	// 添加watch
	function doWatch(source, cb, { immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ, instance = currentInstance) {
		if (!cb) {
			// immediate和deep修饰词必须要添加callback函数
			if (immediate !== undefined) {
				warn(`watch() "immediate" option is only respected when using the ` +
					`watch(source, callback, options?) signature.`);
			}
			if (deep !== undefined) {
				warn(`watch() "deep" option is only respected when using the ` +
					`watch(source, callback, options?) signature.`);
			}
		}
		// 警告函数 - 无效的watch源
		const warnInvalidSource = (s) => {
			warn(`Invalid watch source: `, s, `A watch source can only be a getter/effect function, a ref, ` +
				`a reactive object, or an array of these types.`);
		};
		let getter;
		let forceTrigger = false;
		// ref
		if (isRef(source)) {
			getter = () => source.value;
			forceTrigger = !!source._shallow;
		}
		// reactive
		else if (isReactive(source)) {
			getter = () => source;
			deep = true;
		}
		// 数组
		else if (isArray(source)) {
			getter = () => source.map(s => {
				if (isRef(s)) {
					return s.value;
				}
				else if (isReactive(s)) {
					return traverse(s);
				}
				else if (isFunction(s)) {
					return callWithErrorHandling(s, instance, 2 /* WATCH_GETTER */);
				}
				else {
					warnInvalidSource(s);
				}
			});
		}
		// 函数
		else if (isFunction(source)) {
			if (cb) {
				// 执行source函数，返回监听对象
				getter = () => callWithErrorHandling(source, instance, 2 /* WATCH_GETTER */);
			}
			else {
				getter = () => {
					if (instance && instance.isUnmounted) {
						return;
					}
					if (cleanup) {
						cleanup();
					}
					return callWithErrorHandling(source, instance, 3 /* WATCH_CALLBACK */, [onInvalidate]);
				};
			}
		}
		else {
			getter = NOOP;
			warnInvalidSource(source);
		}
		// deep深度监听，执行穿透函数
		if (cb && deep) {
			const baseGetter = getter;
			getter = () => traverse(baseGetter());
		}
		let cleanup;
		const onInvalidate = (fn) => {
			cleanup = runner.options.onStop = () => {
				callWithErrorHandling(fn, instance, 4 /* WATCH_CLEANUP */);
			};
		};
		let oldValue = isArray(source) ? [] : INITIAL_WATCHER_VALUE;
		// 定义一个任务
		const job = () => {
			if (!runner.active) {
				return;
			}
			if (cb) {
				// watch(source, cb)
				const newValue = runner();
				if (deep || forceTrigger || hasChanged(newValue, oldValue)) {
					if (cleanup) {
						cleanup();
					}
					callWithAsyncErrorHandling(cb, instance, 3 /* WATCH_CALLBACK */, [
						newValue,
						oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
						onInvalidate
					]);
					oldValue = newValue;
				}
			}
			else {
				// watchEffect
				runner();
			}
		};
		job.allowRecurse = !!cb;
		let scheduler;
		if (flush === 'sync') {
			// 同步，一旦值发生了变化，回调将被同步调用
			scheduler = job;
		}
		else if (flush === 'post') {
			// 后置队列，渲染之后调用
			scheduler = () => queuePostRenderEffect(job, instance && instance.suspense);
		}
		else {
			// 前置队列，渲染前执行
			// default: 'pre'
			scheduler = () => {
				if (!instance || instance.isMounted) {
					queuePreFlushCb(job);
				}
				else {
					job();
				}
			};
		}
		const runner = effect(getter, {
			lazy: true,
			onTrack,
			onTrigger,
			scheduler
		});
		recordInstanceBoundEffect(runner);
		// 初始化 run
		if (cb) {
			if (immediate) {
				job();
			}
			else {
				// 设置旧值
				oldValue = runner();
			}
		}
		else if (flush === 'post') {
			queuePostRenderEffect(runner, instance && instance.suspense);
		}
		else {
			runner();
		}
		// 返回一个闭包函数，执行时，停止watch
		return () => {
			stop(runner);
			if (instance) {
				remove(instance.effects, runner);
			}
		};
	}
	// this.$watch
	function instanceWatch(source, cb, options) {
		const publicThis = this.proxy;
		const getter = isString(source)
			? () => publicThis[source] // 获取data中的数据
			: source.bind(publicThis); // 改变this指向vue实例
		return doWatch(getter, cb.bind(publicThis), options, this);
	}
	// traverse - 穿透
	// 遍历value
	function traverse(value, seen = new Set()) {
		if (!isObject(value) || seen.has(value)) {
			return value;
		}
		seen.add(value);
		if (isRef(value)) {
			traverse(value.value, seen);
		}
		else if (isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				traverse(value[i], seen);
			}
		}
		else if (isSet(value) || isMap(value)) {
			value.forEach((v) => {
				traverse(v, seen);
			});
		}
		else {
			for (const key in value) {
				traverse(value[key], seen);
			}
		}
		return value;
	}
	// 使用Transition组件的状态信息
	function useTransitionState() {
		const state = {
			isMounted: false,
			isLeaving: false,
			isUnmounting: false,
			leavingVNodes: new Map()
		};
		onMounted(() => {
			state.isMounted = true;
		});
		onBeforeUnmount(() => {
			state.isUnmounting = true;
		});
		return state;
	}
	const TransitionHookValidator = [Function, Array];
	const BaseTransitionImpl = {
		name: `BaseTransition`,
		props: {
			mode: String,
			appear: Boolean,
			persisted: Boolean,
			// enter
			onBeforeEnter: TransitionHookValidator,
			onEnter: TransitionHookValidator,
			onAfterEnter: TransitionHookValidator,
			onEnterCancelled: TransitionHookValidator,
			// leave
			onBeforeLeave: TransitionHookValidator,
			onLeave: TransitionHookValidator,
			onAfterLeave: TransitionHookValidator,
			onLeaveCancelled: TransitionHookValidator,
			// appear
			onBeforeAppear: TransitionHookValidator,
			onAppear: TransitionHookValidator,
			onAfterAppear: TransitionHookValidator,
			onAppearCancelled: TransitionHookValidator
		},
		setup(props, { slots }) {
			const instance = getCurrentInstance();
			const state = useTransitionState();
			let prevTransitionKey;
			return () => {
				const children = slots.default && getTransitionRawChildren(slots.default(), true);
				if (!children || !children.length) {
					return;
				}
				// warn multiple elements
				if (children.length > 1) {
					warn('<transition> can only be used on a single element or component. Use ' +
						'<transition-group> for lists.');
				}
				// there's no need to track reactivity for these props so use the raw
				// props for a bit better perf
				const rawProps = toRaw(props);
				const { mode } = rawProps;
				// check mode
				if (mode && !['in-out', 'out-in', 'default'].includes(mode)) {
					warn(`invalid <transition> mode: ${mode}`);
				}
				// at this point children has a guaranteed length of 1.
				const child = children[0];
				if (state.isLeaving) {
					return emptyPlaceholder(child);
				}
				// in the case of <transition><keep-alive/></transition>, we need to
				// compare the type of the kept-alive children.
				const innerChild = getKeepAliveChild(child);
				if (!innerChild) {
					return emptyPlaceholder(child);
				}
				const enterHooks = resolveTransitionHooks(innerChild, rawProps, state, instance);
				setTransitionHooks(innerChild, enterHooks);
				const oldChild = instance.subTree;
				const oldInnerChild = oldChild && getKeepAliveChild(oldChild);
				let transitionKeyChanged = false;
				const { getTransitionKey } = innerChild.type;
				if (getTransitionKey) {
					const key = getTransitionKey();
					if (prevTransitionKey === undefined) {
						prevTransitionKey = key;
					}
					else if (key !== prevTransitionKey) {
						prevTransitionKey = key;
						transitionKeyChanged = true;
					}
				}
				// handle mode
				if (oldInnerChild &&
					oldInnerChild.type !== Comment &&
					(!isSameVNodeType(innerChild, oldInnerChild) || transitionKeyChanged)) {
					const leavingHooks = resolveTransitionHooks(oldInnerChild, rawProps, state, instance);
					// update old tree's hooks in case of dynamic transition
					setTransitionHooks(oldInnerChild, leavingHooks);
					// switching between different views
					if (mode === 'out-in') {
						state.isLeaving = true;
						// return placeholder node and queue update when leave finishes
						leavingHooks.afterLeave = () => {
							state.isLeaving = false;
							instance.update();
						};
						return emptyPlaceholder(child);
					}
					else if (mode === 'in-out') {
						leavingHooks.delayLeave = (el, earlyRemove, delayedLeave) => {
							const leavingVNodesCache = getLeavingNodesForType(state, oldInnerChild);
							leavingVNodesCache[String(oldInnerChild.key)] = oldInnerChild;
							// early removal callback
							el._leaveCb = () => {
								earlyRemove();
								el._leaveCb = undefined;
								delete enterHooks.delayedLeave;
							};
							enterHooks.delayedLeave = delayedLeave;
						};
					}
				}
				return child;
			};
		}
	};
	// export the public type for h/tsx inference
	// also to avoid inline import() in generated d.ts files
	const BaseTransition = BaseTransitionImpl;
	function getLeavingNodesForType(state, vnode) {
		const { leavingVNodes } = state;
		let leavingVNodesCache = leavingVNodes.get(vnode.type);
		if (!leavingVNodesCache) {
			leavingVNodesCache = Object.create(null);
			leavingVNodes.set(vnode.type, leavingVNodesCache);
		}
		return leavingVNodesCache;
	}
	// The transition hooks are attached to the vnode as vnode.transition
	// and will be called at appropriate timing in the renderer.
	function resolveTransitionHooks(vnode, props, state, instance) {
		const { appear, mode, persisted = false, onBeforeEnter, onEnter, onAfterEnter, onEnterCancelled, onBeforeLeave, onLeave, onAfterLeave, onLeaveCancelled, onBeforeAppear, onAppear, onAfterAppear, onAppearCancelled } = props;
		const key = String(vnode.key);
		const leavingVNodesCache = getLeavingNodesForType(state, vnode);
		const callHook = (hook, args) => {
			hook &&
				callWithAsyncErrorHandling(hook, instance, 9 /* TRANSITION_HOOK */, args);
		};
		const hooks = {
			mode,
			persisted,
			beforeEnter(el) {
				let hook = onBeforeEnter;
				if (!state.isMounted) {
					if (appear) {
						hook = onBeforeAppear || onBeforeEnter;
					}
					else {
						return;
					}
				}
				// for same element (v-show)
				if (el._leaveCb) {
					el._leaveCb(true /* cancelled */);
				}
				// for toggled element with same key (v-if)
				const leavingVNode = leavingVNodesCache[key];
				if (leavingVNode &&
					isSameVNodeType(vnode, leavingVNode) &&
					leavingVNode.el._leaveCb) {
					// force early removal (not cancelled)
					leavingVNode.el._leaveCb();
				}
				callHook(hook, [el]);
			},
			enter(el) {
				let hook = onEnter;
				let afterHook = onAfterEnter;
				let cancelHook = onEnterCancelled;
				if (!state.isMounted) {
					if (appear) {
						hook = onAppear || onEnter;
						afterHook = onAfterAppear || onAfterEnter;
						cancelHook = onAppearCancelled || onEnterCancelled;
					}
					else {
						return;
					}
				}
				let called = false;
				const done = (el._enterCb = (cancelled) => {
					if (called)
						return;
					called = true;
					if (cancelled) {
						callHook(cancelHook, [el]);
					}
					else {
						callHook(afterHook, [el]);
					}
					if (hooks.delayedLeave) {
						hooks.delayedLeave();
					}
					el._enterCb = undefined;
				});
				if (hook) {
					hook(el, done);
					if (hook.length <= 1) {
						done();
					}
				}
				else {
					done();
				}
			},
			leave(el, remove) {
				const key = String(vnode.key);
				if (el._enterCb) {
					el._enterCb(true /* cancelled */);
				}
				if (state.isUnmounting) {
					return remove();
				}
				callHook(onBeforeLeave, [el]);
				let called = false;
				const done = (el._leaveCb = (cancelled) => {
					if (called)
						return;
					called = true;
					remove();
					if (cancelled) {
						callHook(onLeaveCancelled, [el]);
					}
					else {
						callHook(onAfterLeave, [el]);
					}
					el._leaveCb = undefined;
					if (leavingVNodesCache[key] === vnode) {
						delete leavingVNodesCache[key];
					}
				});
				leavingVNodesCache[key] = vnode;
				if (onLeave) {
					onLeave(el, done);
					if (onLeave.length <= 1) {
						done();
					}
				}
				else {
					done();
				}
			},
			clone(vnode) {
				return resolveTransitionHooks(vnode, props, state, instance);
			}
		};
		return hooks;
	}
	// the placeholder really only handles one special case: KeepAlive
	// in the case of a KeepAlive in a leave phase we need to return a KeepAlive
	// placeholder with empty content to avoid the KeepAlive instance from being
	// unmounted.
	function emptyPlaceholder(vnode) {
		if (isKeepAlive(vnode)) {
			vnode = cloneVNode(vnode);
			vnode.children = null;
			return vnode;
		}
	}
	function getKeepAliveChild(vnode) {
		return isKeepAlive(vnode)
			? vnode.children
				? vnode.children[0]
				: undefined
			: vnode;
	}
	function setTransitionHooks(vnode, hooks) {
		if (vnode.shapeFlag & 6 /* COMPONENT */ && vnode.component) {
			setTransitionHooks(vnode.component.subTree, hooks);
		}
		else if (vnode.shapeFlag & 128 /* SUSPENSE */) {
			vnode.ssContent.transition = hooks.clone(vnode.ssContent);
			vnode.ssFallback.transition = hooks.clone(vnode.ssFallback);
		}
		else {
			vnode.transition = hooks;
		}
	}
	// 获取Transition组件内的原始子元素
	function getTransitionRawChildren(children, keepComment = false) {
		let ret = [];
		let keyedFragmentCount = 0;
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			// e.g. v-for
			if (child.type === Fragment) {
				if (child.patchFlag & 128 /* KEYED_FRAGMENT */)
					keyedFragmentCount++;
				ret = ret.concat(getTransitionRawChildren(child.children, keepComment));
			}
			// 注释节点直接跳过 e.g. v-if
			else if (keepComment || child.type !== Comment) {
				ret.push(child);
			}
		}
		if (keyedFragmentCount > 1) {
			for (let i = 0; i < ret.length; i++) {
				ret[i].patchFlag = -2 /* BAIL */;
			}
		}
		return ret;
	}

	// 判断节点是否为keep-alive
	const isKeepAlive = (vnode) => vnode.type.__isKeepAlive;
	const KeepAliveImpl = {
		name: `KeepAlive`,
		__isKeepAlive: true,
		inheritRef: true,
		props: {
			include: [String, RegExp, Array],
			exclude: [String, RegExp, Array],
			max: [String, Number]
		},
		setup(props, { slots }) {
			const cache = new Map();
			const keys = new Set();
			let current = null;
			const instance = getCurrentInstance();
			const parentSuspense = instance.suspense;
			const sharedContext = instance.ctx;
			const { renderer: { p: patch, m: move, um: _unmount, o: { createElement } } } = sharedContext;
			// 暂存被移除的组件
			const storageContainer = createElement('div');
			// 激活组件
			sharedContext.activate = (vnode, container, anchor, isSVG, optimized) => {
				const instance = vnode.component;
				move(vnode, container, anchor, 0 /* ENTER */, parentSuspense);
				patch(instance.vnode, vnode, container, anchor, instance, parentSuspense, isSVG, optimized);
				queuePostRenderEffect(() => {
					instance.isDeactivated = false;
					if (instance.a) {
						// active-hook
						invokeArrayFns(instance.a);
					}
					// props - onVnodeMounted
					const vnodeHook = vnode.props && vnode.props.onVnodeMounted;
					if (vnodeHook) {
						invokeVNodeHook(vnodeHook, instance.parent, vnode);
					}
				}, parentSuspense);
			};
			// 停用组件
			sharedContext.deactivate = (vnode) => {
				const instance = vnode.component;
				move(vnode, storageContainer, null, 1 /* LEAVE */, parentSuspense);
				queuePostRenderEffect(() => {
					if (instance.da) {
						invokeArrayFns(instance.da);
					}
					const vnodeHook = vnode.props && vnode.props.onVnodeUnmounted;
					if (vnodeHook) {
						invokeVNodeHook(vnodeHook, instance.parent, vnode);
					}
					instance.isDeactivated = true;
				}, parentSuspense);
			};
			// 重置组件状态和卸载组件
			function unmount(vnode) {
				resetShapeFlag(vnode);
				_unmount(vnode, instance, parentSuspense);
			}
			// 删除缓存
			function pruneCache(filter) {
				cache.forEach((vnode, key) => {
					const name = getName(vnode.type);
					if (name && (!filter || !filter(name))) {
						pruneCacheEntry(key);
					}
				});
			}
			// 删除缓存的第一项
			function pruneCacheEntry(key) {
				const cached = cache.get(key);
				if (!current || cached.type !== current.type) {
					// 直接卸载
					unmount(cached);
				}
				else if (current) {
					resetShapeFlag(current);
				}
				cache.delete(key);
				keys.delete(key);
			}
			// 监听include和exclude改变
			watch(() => [props.include, props.exclude], ([include, exclude]) => {
				include && pruneCache(name => matches(include, name));
				exclude && pruneCache(name => !matches(exclude, name));
			}, { flush: 'post' });
			let pendingCacheKey = null;
			const cacheSubtree = () => {
				if (pendingCacheKey != null) {
					// 设置缓存
					cache.set(pendingCacheKey, getInnerChild(instance.subTree));
				}
			};
			onMounted(cacheSubtree);
			onUpdated(cacheSubtree);
			// 卸载前
			onBeforeUnmount(() => {
				cache.forEach(cached => {
					const { subTree, suspense } = instance;
					const vnode = getInnerChild(subTree);
					if (cached.type === vnode.type) {
						resetShapeFlag(vnode);
						// deactivate
						const da = vnode.component.da;
						da && queuePostRenderEffect(da, suspense);
						return;
					}
					unmount(cached);
				});
			});
			return () => {
				// setup返回一个函数，则该函数被赋值为render
				pendingCacheKey = null;
				if (!slots.default) {
					return null;
				}
				const children = slots.default();
				const rawVNode = children[0];
				if (children.length > 1) {
					{
						// keep-alive只能有一个子元素
						warn(`KeepAlive should contain exactly one component child.`);
					}
					current = null;
					return children;
				}
				else if (!isVNode(rawVNode) ||
					(!(rawVNode.shapeFlag & 4 /* STATEFUL_COMPONENT */) &&
						!(rawVNode.shapeFlag & 128 /* SUSPENSE */))) {
					current = null;
					return rawVNode;
				}
				let vnode = getInnerChild(rawVNode);
				const comp = vnode.type;
				const name = getName(comp);
				const { include, exclude, max } = props;
				// 1、include - name不存在，或匹配不到name，返回node
				// 2、exclude - name存在，且匹配到name，返回node
				if ((include && (!name || !matches(include, name))) ||
					(exclude && name && matches(exclude, name))) {
					current = vnode;
					return rawVNode;
				}
				const key = vnode.key == null ? comp : vnode.key;
				const cachedVNode = cache.get(key);
				// 克隆vnode
				if (vnode.el) {
					vnode = cloneVNode(vnode);
					if (rawVNode.shapeFlag & 128 /* SUSPENSE */) {
						rawVNode.ssContent = vnode;
					}
				}
				pendingCacheKey = key;
				// 如果缓存节点存在
				if (cachedVNode) {
					vnode.el = cachedVNode.el;
					vnode.component = cachedVNode.component;
					if (vnode.transition) {
						// 递归设置transition的hooks
						setTransitionHooks(vnode, vnode.transition);
					}
					// no keep-alive
					vnode.shapeFlag |= 512 /* COMPONENT_KEPT_ALIVE */;
					// 标志该key值是刷新过的
					keys.delete(key);
					keys.add(key);
				}
				else {
					keys.add(key);
					if (max && keys.size > parseInt(max, 10)) {
						pruneCacheEntry(keys.values().next().value);
					}
				}
				// keep-alive
				vnode.shapeFlag |= 256 /* COMPONENT_SHOULD_KEEP_ALIVE */;
				current = vnode;
				return rawVNode;
			};
		}
	};
	const KeepAlive = KeepAliveImpl;
	// 获取组件名称
	function getName(comp) {
		return comp.displayName || comp.name;
	}
	// 匹配名称
	function matches(pattern, name) {
		if (isArray(pattern)) {
			return pattern.some((p) => matches(p, name));
		}
		else if (isString(pattern)) {
			return pattern.split(',').indexOf(name) > -1;
		}
		else if (pattern.test) {
			return pattern.test(name);
		}
		return false;
	}
	// 注册被keep-alive缓存的组件激活时的钩子
	function onActivated(hook, target) {
		registerKeepAliveHook(hook, "a" /* ACTIVATED */, target);
	}
	// 注册被keep-alive缓存的组件停用时的钩子
	function onDeactivated(hook, target) {
		registerKeepAliveHook(hook, "da" /* DEACTIVATED */, target);
	}
	// 注册keep-alive钩子
	function registerKeepAliveHook(hook, type, target = currentInstance) {
		const wrappedHook = hook.__wdc ||
			(hook.__wdc = () => {
				let current = target;
				while (current) {
					if (current.isDeactivated) {
						return;
					}
					current = current.parent;
				}
				hook();
			});
		injectHook(type, wrappedHook, target);
		if (target) {
			let current = target.parent;
			while (current && current.parent) {
				if (isKeepAlive(current.parent.vnode)) {
					injectToKeepAliveRoot(wrappedHook, type, target, current);
				}
				current = current.parent;
			}
		}
	}
	// 注入keep-alive根节点的hook
	function injectToKeepAliveRoot(hook, type, target, keepAliveRoot) {
		const injected = injectHook(type, hook, keepAliveRoot, true /* prepend */);
		onUnmounted(() => {
			// 父组件销毁时，移除子组件的钩子
			remove(keepAliveRoot[type], injected);
		}, target);
	}
	// 重置vnode的状态
	function resetShapeFlag(vnode) {
		let shapeFlag = vnode.shapeFlag;
		if (shapeFlag & 256 /* COMPONENT_SHOULD_KEEP_ALIVE */) {
			shapeFlag -= 256 /* COMPONENT_SHOULD_KEEP_ALIVE */;
		}
		if (shapeFlag & 512 /* COMPONENT_KEPT_ALIVE */) {
			shapeFlag -= 512 /* COMPONENT_KEPT_ALIVE */;
		}
		vnode.shapeFlag = shapeFlag;
	}
	// 获取suspense组件的子元素或者普通vnode
	function getInnerChild(vnode) {
		return vnode.shapeFlag & 128 /* SUSPENSE */ ? vnode.ssContent : vnode;
	}

	const isInternalKey = (key) => key[0] === '_' || key === '$stable';
	// 格式化插槽的value值
	const normalizeSlotValue = (value) => isArray(value)
		? value.map(normalizeVNode)
		: [normalizeVNode(value)];
	const normalizeSlot = (key, rawSlot, ctx) => withCtx((props) => {
		if (currentInstance) {
			warn(`Slot "${key}" invoked outside of the render function: ` +
				`this will not track dependencies used in the slot. ` +
				`Invoke the slot function inside the render function instead.`);
		}
		return normalizeSlotValue(rawSlot(props));
	}, ctx);
	const normalizeObjectSlots = (rawSlots, slots) => {
		const ctx = rawSlots._ctx;
		for (const key in rawSlots) {
			if (isInternalKey(key))
				continue;
			const value = rawSlots[key];
			if (isFunction(value)) {
				slots[key] = normalizeSlot(key, value, ctx);
			}
			else if (value != null) {
				{
					warn(`Non-function value encountered for slot "${key}". ` +
						`Prefer function slots for better performance.`);
				}
				const normalized = normalizeSlotValue(value);
				slots[key] = () => normalized;
			}
		}
	};
	// 格式化vnode插槽
	const normalizeVNodeSlots = (instance, children) => {
		if (!isKeepAlive(instance.vnode)) {
			warn(`Non-function value encountered for default slot. ` +
				`Prefer function slots for better performance.`);
		}
		const normalized = normalizeSlotValue(children);
		instance.slots.default = () => normalized;
	};
	// 初始化插槽
	const initSlots = (instance, children) => {
		if (instance.vnode.shapeFlag & 32 /* SLOTS_CHILDREN ---- 插槽子节点 */) {
			const type = children._;
			if (type) {
				instance.slots = children;
				// 标记 `_` 属性不可枚举
				def(children, '_', type);
			}
			else {
				normalizeObjectSlots(children, (instance.slots = {}));
			}
		}
		else {
			instance.slots = {};
			if (children) {
				normalizeVNodeSlots(instance, children);
			}
		}
		def(instance.slots, InternalObjectKey, 1);
	};
	const updateSlots = (instance, children) => {
		const { vnode, slots } = instance;
		let needDeletionCheck = true;
		let deletionComparisonTarget = EMPTY_OBJ;
		if (vnode.shapeFlag & 32 /* SLOTS_CHILDREN */) {
			const type = children._;
			if (type) {
				// compiled slots.
				if (isHmrUpdating) {
					// Parent was HMR updated so slot content may have changed.
					// force update slots and mark instance for hmr as well
					extend(slots, children);
				}
				else if (type === 1 /* STABLE */) {
					// compiled AND stable.
					// no need to update, and skip stale slots removal.
					needDeletionCheck = false;
				}
				else {
					// compiled but dynamic (v-if/v-for on slots) - update slots, but skip
					// normalization.
					extend(slots, children);
				}
			}
			else {
				needDeletionCheck = !children.$stable;
				normalizeObjectSlots(children, slots);
			}
			deletionComparisonTarget = children;
		}
		else if (children) {
			// non slot object children (direct value) passed to a component
			normalizeVNodeSlots(instance, children);
			deletionComparisonTarget = { default: 1 };
		}
		// delete stale slots
		if (needDeletionCheck) {
			for (const key in slots) {
				if (!isInternalKey(key) && !(key in deletionComparisonTarget)) {
					delete slots[key];
				}
			}
		}
	};
	// 校验自定义命令名称
	const isBuiltInDirective = /*#__PURE__*/ makeMap('bind,cloak,else-if,else,for,html,if,model,on,once,pre,show,slot,text');
	function validateDirectiveName(name) {
		if (isBuiltInDirective(name)) {
			warn('Do not use built-in directive ids as custom directive id: ' + name);
		}
	}
	// 创建自定义命令
	function withDirectives(vnode, directives) {
		const internalInstance = currentRenderingInstance;
		if (internalInstance === null) {
			warn(`withDirectives can only be used inside render functions.`);
			return vnode;
		}
		const instance = internalInstance.proxy;
		const bindings = vnode.dirs || (vnode.dirs = []);
		for (let i = 0; i < directives.length; i++) {
			let [dir, value, arg, modifiers = EMPTY_OBJ] = directives[i];
			if (isFunction(dir)) {
				dir = {
					mounted: dir,
					updated: dir
				};
			}
			bindings.push({
				dir,
				instance,
				value,
				oldValue: void 0,
				arg,
				modifiers
			});
		}
		return vnode;
	}
	// 执行自定义命令的生命周期
	function invokeDirectiveHook(vnode, prevVNode, instance, name) {
		const bindings = vnode.dirs;
		const oldBindings = prevVNode && prevVNode.dirs;
		for (let i = 0; i < bindings.length; i++) {
			const binding = bindings[i];
			if (oldBindings) {
				binding.oldValue = oldBindings[i].value;
			}
			const hook = binding.dir[name];
			if (hook) {
				callWithAsyncErrorHandling(hook, instance, 8 /* DIRECTIVE_HOOK */, [
					vnode.el,
					binding,
					vnode,
					prevVNode
				]);
			}
		}
	}

	// 创建app上下文
	function createAppContext() {
		return {
			app: null,
			config: {
				isNativeTag: NO,
				performance: false,
				globalProperties: {},
				optionMergeStrategies: {},
				isCustomElement: NO,
				errorHandler: undefined,
				warnHandler: undefined
			},
			mixins: [],
			components: {},
			directives: {},
			provides: Object.create(null)
		};
	}
	let uid$1 = 0;
	/**
	 * 创建renderAPI
	 * @param {Function} render render函数
	 * @param {Boolean} hydrate 是否为服务端渲染
	 * @returns 
	 */
	function createAppAPI(render, hydrate) {
		// Vue.createApp(options, rootProps) => 第一个参数为options，第二个参数为rootProps
		return function createApp(rootComponent, rootProps = null) {
			// 如果传递了第二个参数，则第二个参数必须为一个对象
			if (rootProps != null && !isObject(rootProps)) {
				warn(`root props passed to app.mount() must be an object.`);
				rootProps = null;
			}
			// 创建上下文对象 => { app, config: {}, mixins: [], components: {}, directives: {}, provides: {} }
			const context = createAppContext();
			const installedPlugins = new Set();
			// 是否已挂载
			let isMounted = false;
			// 返回一个app对象
			const app = (context.app = {
				_uid: uid$1++,
				_component: rootComponent,
				_props: rootProps,
				_container: null,
				_context: context,
				version,
				get config() {
					return context.config;
				},
				set config(v) {
					{
						warn(`app.config cannot be replaced. Modify individual options instead.`);
					}
				},
				use(plugin, ...options) {
					if (installedPlugins.has(plugin)) {
						warn(`Plugin has already been applied to target app.`);
					}
					else if (plugin && isFunction(plugin.install)) {
						installedPlugins.add(plugin);
						plugin.install(app, ...options);
					}
					else if (isFunction(plugin)) {
						installedPlugins.add(plugin);
						plugin(app, ...options);
					}
					else {
						warn(`A plugin must either be a function or an object with an "install" ` +
							`function.`);
					}
					return app;
				},
				mixin(mixin) {
					{
						if (!context.mixins.includes(mixin)) {
							context.mixins.push(mixin);
							// global mixin with props/emits de-optimizes props/emits
							// normalization caching.
							if (mixin.props || mixin.emits) {
								context.deopt = true;
							}
						}
						else {
							warn('Mixin has already been applied to target app' +
								(mixin.name ? `: ${mixin.name}` : ''));
						}
					}
					return app;
				},
				component(name, component) {
					{
						validateComponentName(name, context.config);
					}
					if (!component) {
						return context.components[name];
					}
					if (context.components[name]) {
						warn(`Component "${name}" has already been registered in target app.`);
					}
					context.components[name] = component;
					return app;
				},
				directive(name, directive) {
					{
						validateDirectiveName(name);
					}
					if (!directive) {
						return context.directives[name];
					}
					if (context.directives[name]) {
						warn(`Directive "${name}" has already been registered in target app.`);
					}
					context.directives[name] = directive;
					return app;
				},
				// 开始挂载元素
				// e.g. app.mount("#app")
				mount(rootContainer, isHydrate /* 是否水合，服务端渲染 */) {
					if (!isMounted) {
						// 创建VNode
						const vnode = createVNode(rootComponent, rootProps);
						vnode.appContext = context;
						{
							context.reload = () => {
								render(cloneVNode(vnode), rootContainer);
							};
						}
						if (isHydrate && hydrate) {
							hydrate(vnode, rootContainer);
						}
						else {
							// 开始render
							render(vnode, rootContainer);
						}
						isMounted = true;
						app._container = rootContainer;
						rootContainer.__vue_app__ = app;
						{
							devtoolsInitApp(app, version);
						}
						return vnode.component.proxy;
					}
					else {
						warn(`App has already been mounted.\n` +
							`If you want to remount the same app, move your app creation logic ` +
							`into a factory function and create fresh app instances for each ` +
							`mount - e.g. \`const createMyApp = () => createApp(App)\``);
					}
				},
				unmount() {
					if (isMounted) {
						render(null, app._container);
						{
							devtoolsUnmountApp(app);
						}
					}
					else {
						warn(`Cannot unmount an app that is not mounted.`);
					}
				},
				provide(key, value) {
					if (key in context.provides) {
						warn(`App already provides property with key "${String(key)}". ` +
							`It will be overwritten with the new value.`);
					}
					// TypeScript doesn't allow symbols as index type
					// https://github.com/Microsoft/TypeScript/issues/24587
					context.provides[key] = value;
					return app;
				}
			});
			return app;
		};
	}

	let hasMismatch = false;
	const isSVGContainer = (container) => /svg/.test(container.namespaceURI) && container.tagName !== 'foreignObject';
	const isComment = (node) => node.nodeType === 8 /* COMMENT */;
	function createHydrationFunctions(rendererInternals) {
		const { mt: mountComponent, p: patch, o: { patchProp, nextSibling, parentNode, remove, insert, createComment } } = rendererInternals;
		const hydrate = (vnode, container) => {
			if (!container.hasChildNodes()) {
				warn(`Attempting to hydrate existing markup but container is empty. ` +
					`Performing full mount instead.`);
				patch(null, vnode, container);
				return;
			}
			hasMismatch = false;
			hydrateNode(container.firstChild, vnode, null, null);
			flushPostFlushCbs();
			if (hasMismatch && !false) {
				// this error should show up in production
				console.error(`Hydration completed but contains mismatches.`);
			}
		};
		const hydrateNode = (node, vnode, parentComponent, parentSuspense, optimized = false) => {
			const isFragmentStart = isComment(node) && node.data === '[';
			const onMismatch = () => handleMismatch(node, vnode, parentComponent, parentSuspense, isFragmentStart);
			const { type, ref, shapeFlag } = vnode;
			const domType = node.nodeType;
			vnode.el = node;
			let nextNode = null;
			switch (type) {
				case Text:
					if (domType !== 3 /* TEXT */) {
						nextNode = onMismatch();
					}
					else {
						if (node.data !== vnode.children) {
							hasMismatch = true;

							warn(`Hydration text mismatch:` +
								`\n- Client: ${JSON.stringify(node.data)}` +
								`\n- Server: ${JSON.stringify(vnode.children)}`);
							node.data = vnode.children;
						}
						nextNode = nextSibling(node);
					}
					break;
				case Comment:
					if (domType !== 8 /* COMMENT */ || isFragmentStart) {
						nextNode = onMismatch();
					}
					else {
						nextNode = nextSibling(node);
					}
					break;
				case Static:
					if (domType !== 1 /* ELEMENT */) {
						nextNode = onMismatch();
					}
					else {
						// determine anchor, adopt content
						nextNode = node;
						// if the static vnode has its content stripped during build,
						// adopt it from the server-rendered HTML.
						const needToAdoptContent = !vnode.children.length;
						for (let i = 0; i < vnode.staticCount; i++) {
							if (needToAdoptContent)
								vnode.children += nextNode.outerHTML;
							if (i === vnode.staticCount - 1) {
								vnode.anchor = nextNode;
							}
							nextNode = nextSibling(nextNode);
						}
						return nextNode;
					}
					break;
				case Fragment:
					if (!isFragmentStart) {
						nextNode = onMismatch();
					}
					else {
						nextNode = hydrateFragment(node, vnode, parentComponent, parentSuspense, optimized);
					}
					break;
				default:
					if (shapeFlag & 1 /* ELEMENT */) {
						if (domType !== 1 /* ELEMENT */ ||
							vnode.type !== node.tagName.toLowerCase()) {
							nextNode = onMismatch();
						}
						else {
							nextNode = hydrateElement(node, vnode, parentComponent, parentSuspense, optimized);
						}
					}
					else if (shapeFlag & 6 /* COMPONENT */) {
						// when setting up the render effect, if the initial vnode already
						// has .el set, the component will perform hydration instead of mount
						// on its sub-tree.
						const container = parentNode(node);
						const hydrateComponent = () => {
							mountComponent(vnode, container, null, parentComponent, parentSuspense, isSVGContainer(container), optimized);
						};
						// async component
						const loadAsync = vnode.type.__asyncLoader;
						if (loadAsync) {
							loadAsync().then(hydrateComponent);
						}
						else {
							hydrateComponent();
						}
						// component may be async, so in the case of fragments we cannot rely
						// on component's rendered output to determine the end of the fragment
						// instead, we do a lookahead to find the end anchor node.
						nextNode = isFragmentStart
							? locateClosingAsyncAnchor(node)
							: nextSibling(node);
					}
					else if (shapeFlag & 64 /* TELEPORT */) {
						if (domType !== 8 /* COMMENT */) {
							nextNode = onMismatch();
						}
						else {
							nextNode = vnode.type.hydrate(node, vnode, parentComponent, parentSuspense, optimized, rendererInternals, hydrateChildren);
						}
					}
					else if (shapeFlag & 128 /* SUSPENSE */) {
						nextNode = vnode.type.hydrate(node, vnode, parentComponent, parentSuspense, isSVGContainer(parentNode(node)), optimized, rendererInternals, hydrateNode);
					}
					else {
						warn('Invalid HostVNode type:', type, `(${typeof type})`);
					}
			}
			if (ref != null && parentComponent) {
				setRef(ref, null, parentComponent, parentSuspense, vnode);
			}
			return nextNode;
		};
		const hydrateElement = (el, vnode, parentComponent, parentSuspense, optimized) => {
			optimized = optimized || !!vnode.dynamicChildren;
			const { props, patchFlag, shapeFlag, dirs } = vnode;
			// skip props & children if this is hoisted static nodes
			if (patchFlag !== -1 /* HOISTED */) {
				if (dirs) {
					invokeDirectiveHook(vnode, null, parentComponent, 'created');
				}
				// props
				if (props) {
					if (!optimized ||
						(patchFlag & 16 /* FULL_PROPS */ ||
							patchFlag & 32 /* HYDRATE_EVENTS */)) {
						for (const key in props) {
							if (!isReservedProp(key) && isOn(key)) {
								patchProp(el, key, null, props[key]);
							}
						}
					}
					else if (props.onClick) {
						// Fast path for click listeners (which is most often) to avoid
						// iterating through props.
						patchProp(el, 'onClick', null, props.onClick);
					}
				}
				// vnode / directive hooks
				let vnodeHooks;
				if ((vnodeHooks = props && props.onVnodeBeforeMount)) {
					invokeVNodeHook(vnodeHooks, parentComponent, vnode);
				}
				if (dirs) {
					invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount');
				}
				if ((vnodeHooks = props && props.onVnodeMounted) || dirs) {
					queueEffectWithSuspense(() => {
						vnodeHooks && invokeVNodeHook(vnodeHooks, parentComponent, vnode);
						dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted');
					}, parentSuspense);
				}
				// children
				if (shapeFlag & 16 /* ARRAY_CHILDREN */ &&
					// skip if element has innerHTML / textContent
					!(props && (props.innerHTML || props.textContent))) {
					let next = hydrateChildren(el.firstChild, vnode, el, parentComponent, parentSuspense, optimized);
					let hasWarned = false;
					while (next) {
						hasMismatch = true;
						if (!hasWarned) {
							warn(`Hydration children mismatch in <${vnode.type}>: ` +
								`server rendered element contains more child nodes than client vdom.`);
							hasWarned = true;
						}
						// The SSRed DOM contains more nodes than it should. Remove them.
						const cur = next;
						next = next.nextSibling;
						remove(cur);
					}
				}
				else if (shapeFlag & 8 /* TEXT_CHILDREN */) {
					if (el.textContent !== vnode.children) {
						hasMismatch = true;

						warn(`Hydration text content mismatch in <${vnode.type}>:\n` +
							`- Client: ${el.textContent}\n` +
							`- Server: ${vnode.children}`);
						el.textContent = vnode.children;
					}
				}
			}
			return el.nextSibling;
		};
		const hydrateChildren = (node, parentVNode, container, parentComponent, parentSuspense, optimized) => {
			optimized = optimized || !!parentVNode.dynamicChildren;
			const children = parentVNode.children;
			const l = children.length;
			let hasWarned = false;
			for (let i = 0; i < l; i++) {
				const vnode = optimized
					? children[i]
					: (children[i] = normalizeVNode(children[i]));
				if (node) {
					node = hydrateNode(node, vnode, parentComponent, parentSuspense, optimized);
				}
				else {
					hasMismatch = true;
					if (!hasWarned) {
						warn(`Hydration children mismatch in <${container.tagName.toLowerCase()}>: ` +
							`server rendered element contains fewer child nodes than client vdom.`);
						hasWarned = true;
					}
					// the SSRed DOM didn't contain enough nodes. Mount the missing ones.
					patch(null, vnode, container, null, parentComponent, parentSuspense, isSVGContainer(container));
				}
			}
			return node;
		};
		const hydrateFragment = (node, vnode, parentComponent, parentSuspense, optimized) => {
			const container = parentNode(node);
			const next = hydrateChildren(nextSibling(node), vnode, container, parentComponent, parentSuspense, optimized);
			if (next && isComment(next) && next.data === ']') {
				return nextSibling((vnode.anchor = next));
			}
			else {
				// fragment didn't hydrate successfully, since we didn't get a end anchor
				// back. This should have led to node/children mismatch warnings.
				hasMismatch = true;
				// since the anchor is missing, we need to create one and insert it
				insert((vnode.anchor = createComment(`]`)), container, next);
				return next;
			}
		};
		const handleMismatch = (node, vnode, parentComponent, parentSuspense, isFragment) => {
			hasMismatch = true;

			warn(`Hydration node mismatch:\n- Client vnode:`, vnode.type, `\n- Server rendered DOM:`, node, node.nodeType === 3 /* TEXT */
				? `(text)`
				: isComment(node) && node.data === '['
					? `(start of fragment)`
					: ``);
			vnode.el = null;
			if (isFragment) {
				// remove excessive fragment nodes
				const end = locateClosingAsyncAnchor(node);
				while (true) {
					const next = nextSibling(node);
					if (next && next !== end) {
						remove(next);
					}
					else {
						break;
					}
				}
			}
			const next = nextSibling(node);
			const container = parentNode(node);
			remove(node);
			patch(null, vnode, container, next, parentComponent, parentSuspense, isSVGContainer(container));
			return next;
		};
		const locateClosingAsyncAnchor = (node) => {
			let match = 0;
			while (node) {
				node = nextSibling(node);
				if (node && isComment(node)) {
					if (node.data === '[')
						match++;
					if (node.data === ']') {
						if (match === 0) {
							return nextSibling(node);
						}
						else {
							match--;
						}
					}
				}
			}
			return node;
		};
		return [hydrate, hydrateNode];
	}

	let supported;
	let perf;
	// 开启性能监测
	function startMeasure(instance, type) {
		if (instance.appContext.config.performance && isSupported()) {
			perf.mark(`vue-${type}-${instance.uid}`);
		}
	}
	// 停止性能监测
	function endMeasure(instance, type) {
		if (instance.appContext.config.performance && isSupported()) {
			const startTag = `vue-${type}-${instance.uid}`;
			const endTag = startTag + `:end`;
			perf.mark(endTag);
			perf.measure(`<${formatComponentName(instance, instance.type)}> ${type}`, startTag, endTag);
			perf.clearMarks(startTag);
			perf.clearMarks(endTag);
		}
	}
	// 判断浏览器是否支持性能监测
	function isSupported() {
		if (supported !== undefined) {
			return supported;
		}
		if (typeof window !== 'undefined' && window.performance) {
			supported = true;
			perf = window.performance;
		}
		else {
			supported = false;
		}
		return supported;
	}
	// 创建dev effect options
	function createDevEffectOptions(instance) {
		return {
			scheduler: queueJob,
			allowRecurse: true,
			onTrack: instance.rtc ? e => invokeArrayFns(instance.rtc, e) : void 0,
			onTrigger: instance.rtg ? e => invokeArrayFns(instance.rtg, e) : void 0
		};
	}
	const queuePostRenderEffect = queueEffectWithSuspense
		;
	const setRef = (rawRef, oldRawRef, parentComponent, parentSuspense, vnode) => {
		if (isArray(rawRef)) {
			rawRef.forEach((r, i) => setRef(r, oldRawRef && (isArray(oldRawRef) ? oldRawRef[i] : oldRawRef), parentComponent, parentSuspense, vnode));
			return;
		}
		let value;
		if (!vnode) {
			value = null;
		}
		else {
			if (vnode.shapeFlag & 4 /* STATEFUL_COMPONENT */) {
				value = vnode.component.proxy;
			}
			else {
				value = vnode.el;
			}
		}
		const { i: owner, r: ref } = rawRef;
		if (!owner) {
			warn(`Missing ref owner context. ref cannot be used on hoisted vnodes. ` +
				`A vnode with ref must be created inside the render function.`);
			return;
		}
		const oldRef = oldRawRef && oldRawRef.r;
		const refs = owner.refs === EMPTY_OBJ ? (owner.refs = {}) : owner.refs;
		const setupState = owner.setupState;
		// unset old ref
		if (oldRef != null && oldRef !== ref) {
			if (isString(oldRef)) {
				refs[oldRef] = null;
				if (hasOwn(setupState, oldRef)) {
					setupState[oldRef] = null;
				}
			}
			else if (isRef(oldRef)) {
				oldRef.value = null;
			}
		}
		if (isString(ref)) {
			const doSet = () => {
				refs[ref] = value;
				if (hasOwn(setupState, ref)) {
					setupState[ref] = value;
				}
			};
			// #1789: for non-null values, set them after render
			// null values means this is unmount and it should not overwrite another
			// ref with the same key
			if (value) {
				doSet.id = -1;
				queuePostRenderEffect(doSet, parentSuspense);
			}
			else {
				doSet();
			}
		}
		else if (isRef(ref)) {
			const doSet = () => {
				ref.value = value;
			};
			if (value) {
				doSet.id = -1;
				queuePostRenderEffect(doSet, parentSuspense);
			}
			else {
				doSet();
			}
		}
		else if (isFunction(ref)) {
			callWithErrorHandling(ref, parentComponent, 12 /* FUNCTION_REF */, [
				value,
				refs
			]);
		}
		else {
			warn('Invalid template ref type:', value, `(${typeof value})`);
		}
	};
	/**
	 * 创建普通的render函数
	 */
	function createRenderer(options) {
		return baseCreateRenderer(options);
	}
	// 创建服务端渲染render函数
	function createHydrationRenderer(options) {
		return baseCreateRenderer(options, createHydrationFunctions);
	}
	
	/**
	 * 创建普通的render函数，可以接收两个泛型参数：
	 * 
	 * 自定义渲染器可以在平台中传递特定类型，像这样：
	 * 
	 * ``` js
	 * const { render, createApp } = createRenderer<Node, Element>({
	 * 	patchProp,
	 * 	...nodeOps
	 * })
	 * ```
	 */
	function baseCreateRenderer(options, createHydrationFns) {
		const { insert: hostInsert, remove: hostRemove, patchProp: hostPatchProp, forcePatchProp: hostForcePatchProp, createElement: hostCreateElement, createText: hostCreateText, createComment: hostCreateComment, setText: hostSetText, setElementText: hostSetElementText, parentNode: hostParentNode, nextSibling: hostNextSibling, setScopeId: hostSetScopeId = NOOP, cloneNode: hostCloneNode, insertStaticContent: hostInsertStaticContent } = options;
		
		// patch函数
		// pathc的意思为打补丁
		// 通过打补丁的形式充分利用原有的DOM进行增加、删除、移动的操作，从而避免重新创建大量的DOM操作
		const patch = (n1, n2, container, anchor = null, parentComponent = null, parentSuspense = null, isSVG = false, optimized = false) => {
			// 更新时，如果旧节点和新节点不一致，则卸载旧节点，创建新节点
			// e.g. v-if
			if (n1 && !isSameVNodeType(n1, n2)) {
				anchor /* 锚点 */ = getNextHostNode(n1);
				unmount(n1, parentComponent, parentSuspense, true);
				n1 = null;
			}
			if (n2.patchFlag === -2 /* BAIL */) {
				optimized = false;
				n2.dynamicChildren = null;
			}
			const { type, ref, shapeFlag } = n2;
			switch (type) {
				case Text:
					processText(n1, n2, container, anchor);
					break;
				case Comment:
					processCommentNode(n1, n2, container, anchor);
					break;
				case Static:
					if (n1 == null) {
						mountStaticNode(n2, container, anchor, isSVG);
					}
					else {
						patchStaticNode(n1, n2, container, isSVG);
					}
					break;
				case Fragment:
					processFragment(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
					break;
				default:
					if (shapeFlag & 1 /* ELEMENT */) {
						processElement(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
					}
					else if (shapeFlag & 6 /* COMPONENT */) {
						// process的意思为加工、处理
						processComponent(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
					}
					else if (shapeFlag & 64 /* TELEPORT */) {
						type.process(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized, internals);
					}
					else if (shapeFlag & 128 /* SUSPENSE */) {
						// 执行suspense组件的process处理函数
						type.process(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized, internals);
					}
					else {
						warn('Invalid VNode type:', type, `(${typeof type})`);
					}
			}
			// 设置 ref
			if (ref != null && parentComponent) {
				setRef(ref, n1 && n1.ref, parentComponent, parentSuspense, n2);
			}
		};
		// 处理文本
		/*
			e.g. 
			<div id="app">
				fanqiewa
			</div>
		*/
		const processText = (n1, n2, container, anchor) => {
			if (n1 == null) {
				// 第一次渲染
				hostInsert((n2.el = hostCreateText(n2.children)), container, anchor);
			}
			else {
				const el = (n2.el = n1.el);
				// 重新渲染时，文本内容不一致
				if (n2.children !== n1.children) {
					hostSetText(el, n2.children);
				}
			}
		};
		// 处理注释节点
		const processCommentNode = (n1, n2, container, anchor) => {
			if (n1 == null) {
				hostInsert((n2.el = hostCreateComment(n2.children || '')), container, anchor);
			}
			else {
				// 不支持动态内容
				n2.el = n1.el;
			}
		};
		const mountStaticNode = (n2, container, anchor, isSVG) => {
			[n2.el, n2.anchor] = hostInsertStaticContent(n2.children, container, anchor, isSVG);
		};
		// 
		const patchStaticNode = (n1, n2, container, isSVG) => {
			// static nodes are only patched during dev for HMR
			if (n2.children !== n1.children) {
				const anchor = hostNextSibling(n1.anchor);
				// remove existing
				removeStaticNode(n1);
				[n2.el, n2.anchor] = hostInsertStaticContent(n2.children, container, anchor, isSVG);
			}
			else {
				n2.el = n1.el;
				n2.anchor = n1.anchor;
			}
		};
		/**
		 * Dev / HMR only
		 */
		const moveStaticNode = (vnode, container, anchor) => {
			let cur = vnode.el;
			const end = vnode.anchor;
			while (cur && cur !== end) {
				const next = hostNextSibling(cur);
				hostInsert(cur, container, anchor);
				cur = next;
			}
			hostInsert(end, container, anchor);
		};
		/**
		 * Dev / HMR only
		 */
		const removeStaticNode = (vnode) => {
			let cur = vnode.el;
			while (cur && cur !== vnode.anchor) {
				const next = hostNextSibling(cur);
				hostRemove(cur);
				cur = next;
			}
			hostRemove(vnode.anchor);
		};
		// 处理Element类型节点
		const processElement = (n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized) => {
			isSVG = isSVG || n2.type === 'svg';
			if (n1 == null) {
				mountElement(n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
			}
			else {
				patchElement(n1, n2, parentComponent, parentSuspense, isSVG, optimized);
			}
		};
		// 挂载Element
		const mountElement = (vnode, container, anchor, parentComponent, parentSuspense, isSVG, optimized) => {
			let el;
			let vnodeHook;
			const { type, props, shapeFlag, transition, scopeId, patchFlag, dirs } = vnode;
			{
				el = vnode.el = hostCreateElement(vnode.type, isSVG, props && props.is);
				if (shapeFlag & 8 /* TEXT_CHILDREN ---- 文本子节点 */) {
					hostSetElementText(el, vnode.children);
				}
				else if (shapeFlag & 16 /* ARRAY_CHILDREN ---- 数组类型的子节点 */) {
					mountChildren(vnode.children, el, null, parentComponent, parentSuspense, isSVG && type !== 'foreignObject', optimized || !!vnode.dynamicChildren);
				}
				if (dirs) {
					// 触发自定义指令的钩子函数created
					invokeDirectiveHook(vnode, null, parentComponent, 'created');
				}
				// props
				if (props) {
					for (const key in props) {
						if (!isReservedProp(key)) {
							hostPatchProp(el, key, null, props[key], isSVG, vnode.children, parentComponent, parentSuspense, unmountChildren);
						}
					}
					// 触发vnode挂载前的钩子函数
					// e.g. <button v-bind:[name]="onVnodeBeforeMount">toggle</button>
					// name = onVnodeBeforeMount
					if ((vnodeHook = props.onVnodeBeforeMount)) {
						invokeVNodeHook(vnodeHook, parentComponent, vnode);
					}
				}
				// 设置scopeId
				setScopeId(el, scopeId, vnode, parentComponent);
			}
			{
				Object.defineProperty(el, '__vnode', {
					value: vnode,
					enumerable: false
				});
				Object.defineProperty(el, '__vueParentComponent', {
					value: parentComponent,
					enumerable: false
				});
			}
			if (dirs) {
				// 触发自定义指令的钩子函数beforeMount
				invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount');
			}
			// 是否需要触发transition hook
			const needCallTransitionHooks = (!parentSuspense || (parentSuspense && !parentSuspense.pendingBranch)) &&
				transition &&
				!transition.persisted;
			if (needCallTransitionHooks) {
				transition.beforeEnter(el);
			}
			// 插入节点
			hostInsert(el, container, anchor);
			// 触发钩子函数
			if ((vnodeHook = props && props.onVnodeMounted /* 节点挂载钩子 */) ||
				needCallTransitionHooks ||
				dirs) {
				queuePostRenderEffect(() => {
					vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
					needCallTransitionHooks && transition.enter(el);
					dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted');
				}, parentSuspense);
			}
		};
		// 设置作用域ID
		const setScopeId = (el, scopeId, vnode, parentComponent) => {
			if (scopeId) {
				hostSetScopeId(el, scopeId);
			}
			if (parentComponent) {
				const treeOwnerId = parentComponent.type.__scopeId;
				// vnode节点的scopeId和当前组件的作用域scopeId不一致时 - 这可能是一个插槽内容
				if (treeOwnerId && treeOwnerId !== scopeId) {
					hostSetScopeId(el, treeOwnerId + '-s');
				}
				let subTree = parentComponent.subTree;
				if (subTree.type === Fragment) {
					subTree =
						filterSingleRoot(subTree.children) || subTree;
				}
				if (vnode === subTree) {
					setScopeId(el, parentComponent.vnode.scopeId, parentComponent.vnode, parentComponent.parent);
				}
			}
		};
		// 挂载子元素
		const mountChildren = (children, container, anchor, parentComponent, parentSuspense, isSVG, optimized, start = 0) => {
			for (let i = start; i < children.length; i++) {
				const child = (children[i] = optimized
					? cloneIfMounted(children[i]) // 如果是优化，则直接克隆子节点
					: normalizeVNode(children[i])); // 否则创建一个新的
				patch(null, child, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
			}
		};
		// 修补Element
		const patchElement = (n1, n2, parentComponent, parentSuspense, isSVG, optimized) => {
			const el = (n2.el = n1.el);
			let { patchFlag, dynamicChildren, dirs } = n2;
			patchFlag |= n1.patchFlag & 16 /* FULL_PROPS */;
			const oldProps = n1.props || EMPTY_OBJ;
			const newProps = n2.props || EMPTY_OBJ;
			let vnodeHook;
			if ((vnodeHook = newProps.onVnodeBeforeUpdate)) {
				// 触发vnode更新前的钩子函数
				invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
			}
			if (dirs) {
				// 触发自定义指令的beforeUpdate钩子函数
				invokeDirectiveHook(n2, n1, parentComponent, 'beforeUpdate');
			}
			if (isHmrUpdating) {
				patchFlag = 0;
				optimized = false;
				dynamicChildren = null;
			}
			if (patchFlag > 0) {
				if (patchFlag & 16 /* FULL_PROPS */) {
					// 动态props
					patchProps(el, n2, oldProps, newProps, parentComponent, parentSuspense, isSVG);
				}
				else {
					// class
					if (patchFlag & 2 /* CLASS */) {
						if (oldProps.class !== newProps.class) {
							hostPatchProp(el, 'class', null, newProps.class, isSVG);
						}
					}
					// style
					if (patchFlag & 4 /* STYLE */) {
						hostPatchProp(el, 'style', oldProps.style, newProps.style, isSVG);
					}
					if (patchFlag & 8 /* PROPS */) {
						const propsToUpdate = n2.dynamicProps;
						for (let i = 0; i < propsToUpdate.length; i++) {
							const key = propsToUpdate[i];
							const prev = oldProps[key];
							const next = newProps[key];
							if (next !== prev ||
								(hostForcePatchProp && hostForcePatchProp(el, key))) {
								hostPatchProp(el, key, prev, next, isSVG, n1.children, parentComponent, parentSuspense, unmountChildren);
							}
						}
					}
				}
				if (patchFlag & 1 /* TEXT */) {
					if (n1.children !== n2.children) {
						hostSetElementText(el, n2.children);
					}
				}
			}
			else if (!optimized && dynamicChildren == null) {
				// 不优化，修补全部props
				patchProps(el, n2, oldProps, newProps, parentComponent, parentSuspense, isSVG);
			}
			const areChildrenSVG = isSVG && n2.type !== 'foreignObject';
			if (dynamicChildren) {
				patchBlockChildren(n1.dynamicChildren, dynamicChildren, el, parentComponent, parentSuspense, areChildrenSVG);
				if (
					parentComponent &&
					parentComponent.type.__hmrId) {
					traverseStaticChildren(n1, n2);
				}
			}
			else if (!optimized) {
				// 全部 diff
				patchChildren(n1, n2, el, null, parentComponent, parentSuspense, areChildrenSVG);
			}
			// 触发钩子
			if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
				queuePostRenderEffect(() => {
					vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
					dirs && invokeDirectiveHook(n2, n1, parentComponent, 'updated');
				}, parentSuspense);
			}
		};
		// 快速对比子节点
		const patchBlockChildren = (oldChildren, newChildren, fallbackContainer, parentComponent, parentSuspense, isSVG) => {
			for (let i = 0; i < newChildren.length; i++) {
				const oldVNode = oldChildren[i];
				const newVNode = newChildren[i];
				const container =
					// 旧节点的type为Fragment
					oldVNode.type === Fragment ||
						// 旧节点和新节点类型不一致
						!isSameVNodeType(oldVNode, newVNode) ||
						// 组件可能会包含任意内容
						oldVNode.shapeFlag & 6 /* COMPONENT */ ||
						oldVNode.shapeFlag & 64 /* TELEPORT */
						? hostParentNode(oldVNode.el)
						// 使用旧的容器
						: fallbackContainer;
				patch(oldVNode, newVNode, container, null, parentComponent, parentSuspense, isSVG, true);
			}
		};
		// 修补props
		const patchProps = (el, vnode, oldProps, newProps, parentComponent, parentSuspense, isSVG) => {
			if (oldProps !== newProps) {
				for (const key in newProps) {
					if (isReservedProp(key))
						continue;
					const next = newProps[key];
					const prev = oldProps[key];
					if (next !== prev ||
						(hostForcePatchProp && hostForcePatchProp(el, key))) {
						hostPatchProp(el, key, prev, next, isSVG, vnode.children, parentComponent, parentSuspense, unmountChildren);
					}
				}
				if (oldProps !== EMPTY_OBJ) {
					for (const key in oldProps) {
						if (!isReservedProp(key) && !(key in newProps)) {
							hostPatchProp(el, key, oldProps[key], null, isSVG, vnode.children, parentComponent, parentSuspense, unmountChildren);
						}
					}
				}
			}
		};
		// 修补Fragment类型节点
		const processFragment = (n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized) => {
			// 开始锚点
			const fragmentStartAnchor = (n2.el = n1 ? n1.el : hostCreateText(''));
			// 结束锚点
			const fragmentEndAnchor = (n2.anchor = n1 ? n1.anchor : hostCreateText(''));
			let { patchFlag, dynamicChildren } = n2;
			if (patchFlag > 0) {
				optimized = true;
			}
			if (isHmrUpdating) {
				// HMR updated, 触发所有更新
				patchFlag = 0;
				optimized = false;
				dynamicChildren = null;
			}
			if (n1 == null) {
				hostInsert(fragmentStartAnchor, container, anchor);
				hostInsert(fragmentEndAnchor, container, anchor);
				// 挂载子元素
				mountChildren(n2.children, container, fragmentEndAnchor, parentComponent, parentSuspense, isSVG, optimized);
			}
			else {
				if (patchFlag > 0 &&
					patchFlag & 64 /* STABLE_FRAGMENT ---- 固定的Fragment，即该节点及其子节点可能不会改变 */ &&
					dynamicChildren) {
					patchBlockChildren(n1.dynamicChildren, dynamicChildren, container, parentComponent, parentSuspense, isSVG);
					if (parentComponent && parentComponent.type.__hmrId) {
						traverseStaticChildren(n1, n2);
					}
					else if (
						n2.key != null ||
						(parentComponent && n2 === parentComponent.subTree)) {
						traverseStaticChildren(n1, n2, true /* shallow */);
					}
				}
				else {
					// 默认修补子节点
					patchChildren(n1, n2, container, fragmentEndAnchor, parentComponent, parentSuspense, isSVG, optimized);
				}
			}
		};
		// 处理组件
		const processComponent = (n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized) => {
			if (n1 == null) {
				if (n2.shapeFlag & 512 /* COMPONENT_KEPT_ALIVE */) {
					parentComponent.ctx.activate(n2, container, anchor, isSVG, optimized);
				}
				else {
					// 挂载组件
					mountComponent(n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
				}
			}
			else {
				// 更新组件
				updateComponent(n1, n2, optimized);
			}
		};
		// 挂载组件
		const mountComponent = (initialVNode, container, anchor, parentComponent, parentSuspense, isSVG, optimized) => {
			// 组件实例
			const instance = (initialVNode.component = createComponentInstance(initialVNode, parentComponent, parentSuspense));
			if (instance.type.__hmrId) {
				// TODO
				registerHMR(instance);
			}
			{
				// 在挂载组件时，添加警告上下文
				pushWarningContext(initialVNode);
				// 开启记录挂载性能监测
				startMeasure(instance, `mount`);
			}
			// TODO
			if (isKeepAlive(initialVNode)) {
				instance.ctx.renderer = internals;
			}
			// 开启记录初始化组件性能监测
			{
				startMeasure(instance, `init`);
			}
			// 开始安装组件
			setupComponent(instance);
			{
				// 结束记录初始化组件性能监测
				endMeasure(instance, `init`);
			}
			// setup函数返回一个异步对象时
			if (instance.asyncDep) {
				// 父组件为suspense时
				parentSuspense && parentSuspense.registerDep(instance, setupRenderEffect);
				if (!initialVNode.el) {
					const placeholder = (instance.subTree = createVNode(Comment));
					processCommentNode(null, placeholder, container, anchor);
				}
				return;
			}
			setupRenderEffect(instance, initialVNode, container, anchor, parentSuspense, isSVG, optimized);
			{
				popWarningContext();
				endMeasure(instance, `mount`);
			}
		};
		// 更新组件
		const updateComponent = (n1, n2, optimized) => {
			const instance = (n2.component = n1.component);
			if (shouldUpdateComponent(n1, n2, optimized)) {
				if (
					instance.asyncDep &&
					!instance.asyncResolved) {
					{
						pushWarningContext(n2);
					}
					updateComponentPreRender(instance, n2, optimized);
					{
						popWarningContext();
					}
					return;
				}
				else {
					// 正常更新
					instance.next = n2;
					// 在这种情况下，避免重复更新相同的子组件（在刷新的时候）
					invalidateJob(instance.update);
					// instance.update触发响应
					instance.update();
				}
			}
			else {
				// 直接更新元素
				n2.component = n1.component;
				n2.el = n1.el;
				instance.vnode = n2;
			}
		};
		// 安装渲染effect
		const setupRenderEffect = (instance, initialVNode, container, anchor, parentSuspense, isSVG, optimized) => {
			// 创建一个effect
			instance.update = effect(function componentEffect() {
				if (!instance.isMounted) {
					let vnodeHook;
					const { el, props } = initialVNode;
					const { bm, m, parent } = instance;
					if (bm) {
						// ---------------beforeMount生命周期
						invokeArrayFns(bm);
					}
					// onVnodeBeforeMount
					if ((vnodeHook = props && props.onVnodeBeforeMount)) {
						invokeVNodeHook(vnodeHook, parent, initialVNode);
					}
					// render
					{
						startMeasure(instance, `render`);
					}
					// 语法树
					const subTree = (instance.subTree = renderComponentRoot(instance));
					{
						endMeasure(instance, `render`);
					}
					if (el && hydrateNode) {
						{
							startMeasure(instance, `hydrate`);
						}
						// 水合创建vnode
						hydrateNode(initialVNode.el, subTree, instance, parentSuspense);
						{
							endMeasure(instance, `hydrate`);
						}
					}
					else {
						{
							startMeasure(instance, `patch`);
						}
						patch(null, subTree, container, anchor, instance, parentSuspense, isSVG);
						{
							endMeasure(instance, `patch`);
						}
						initialVNode.el = subTree.el;
					}
					if (m) {
						// -----------------mounted生命周期
						queuePostRenderEffect(m, parentSuspense);
					}
					// onVnodeMounted
					if ((vnodeHook = props && props.onVnodeMounted)) {
						queuePostRenderEffect(() => {
							invokeVNodeHook(vnodeHook, parent, initialVNode);
						}, parentSuspense);
					}
					const { a } = instance;
					if (a &&
						initialVNode.shapeFlag & 256 /* COMPONENT_SHOULD_KEEP_ALIVE */) {
						queuePostRenderEffect(a, parentSuspense);
					}
					instance.isMounted = true;
				}
				else {
					// --------------------beforeUpdate生命周期
					let { next, bu, u, parent, vnode } = instance;
					let originNext = next;
					let vnodeHook;
					{
						pushWarningContext(next || instance.vnode);
					}
					if (next) {
						next.el = vnode.el;
						updateComponentPreRender(instance, next, optimized);
					}
					else {
						next = vnode;
					}
					// ---------------------beforeUpdate生命周期
					if (bu) {
						invokeArrayFns(bu);
					}
					// onVnodeBeforeUpdate
					if ((vnodeHook = next.props && next.props.onVnodeBeforeUpdate)) {
						invokeVNodeHook(vnodeHook, parent, next, vnode);
					}
					// render
					{
						startMeasure(instance, `render`);
					}
					const nextTree = renderComponentRoot(instance);
					{
						endMeasure(instance, `render`);
					}
					const prevTree = instance.subTree;
					instance.subTree = nextTree;
					{
						startMeasure(instance, `patch`);
					}
					patch(prevTree, nextTree,
						// 父容器可能更改了，所以重新获取一次
						hostParentNode(prevTree.el),
						// 锚点可能也改了
						getNextHostNode(prevTree), instance, parentSuspense, isSVG);
					{
						endMeasure(instance, `patch`);
					}
					next.el = nextTree.el;
					if (originNext === null) {
						updateHOCHostEl(instance, nextTree.el);
					}
					// -------------------updatede生命周期
					if (u) {
						queuePostRenderEffect(u, parentSuspense);
					}
					// onVnodeUpdated
					if ((vnodeHook = next.props && next.props.onVnodeUpdated)) {
						queuePostRenderEffect(() => {
							invokeVNodeHook(vnodeHook, parent, next, vnode);
						}, parentSuspense);
					}
					{
						devtoolsComponentUpdated(instance);
					}
					{
						popWarningContext();
					}
				}
			}, createDevEffectOptions(instance));
		};
		// 更新旧组件的节点状态
		const updateComponentPreRender = (instance, nextVNode, optimized) => {
			nextVNode.component = instance;
			const prevProps = instance.vnode.props;
			instance.vnode = nextVNode;
			instance.next = null;
			updateProps(instance, nextVNode.props, prevProps, optimized);
			updateSlots(instance, nextVNode.children);
			// 在渲染前先更新一下，因为props更新可能会触发前面的监听器响应
			flushPreFlushCbs(undefined, instance.update);
		};
		// 修补子节点
		const patchChildren = (n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized = false) => {
			const c1 = n1 && n1.children;
			const prevShapeFlag = n1 ? n1.shapeFlag : 0;
			const c2 = n2.children;
			const { patchFlag, shapeFlag } = n2;
			// 快速对比通道
			if (patchFlag > 0) {
				if (patchFlag & 128 /* KEYED_FRAGMENT */) {
					// 有key值的Fragment
					patchKeyedChildren(c1, c2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
					return;
				}
				else if (patchFlag & 256 /* UNKEYED_FRAGMENT */) {
					// 无key值的Fragment
					patchUnkeyedChildren(c1, c2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
					return;
				}
			}
			// children has 3 possibilities: text, array or no children.
			if (shapeFlag & 8 /* TEXT_CHILDREN */) {
				// text children fast path
				if (prevShapeFlag & 16 /* ARRAY_CHILDREN */) {
					unmountChildren(c1, parentComponent, parentSuspense);
				}
				if (c2 !== c1) {
					hostSetElementText(container, c2);
				}
			}
			else {
				if (prevShapeFlag & 16 /* ARRAY_CHILDREN */) {
					// prev children was array
					if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
						// two arrays, cannot assume anything, do full diff
						patchKeyedChildren(c1, c2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
					}
					else {
						// no new children, just unmount old
						unmountChildren(c1, parentComponent, parentSuspense, true);
					}
				}
				else {
					// prev children was text OR null
					// new children is array OR null
					if (prevShapeFlag & 8 /* TEXT_CHILDREN */) {
						hostSetElementText(container, '');
					}
					// mount new if array
					if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
						mountChildren(c2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
					}
				}
			}
		};
		// 修补无key值的子节点
		const patchUnkeyedChildren = (c1, c2, container, anchor, parentComponent, parentSuspense, isSVG, optimized) => {
			c1 = c1 || EMPTY_ARR;
			c2 = c2 || EMPTY_ARR;
			const oldLength = c1.length;
			const newLength = c2.length;
			// 公共的数组长度
			const commonLength = Math.min(oldLength, newLength);
			let i;
			for (i = 0; i < commonLength; i++) {
				const nextChild = (c2[i] = optimized
					? cloneIfMounted(c2[i])
					: normalizeVNode(c2[i]));
				patch(c1[i], nextChild, container, null, parentComponent, parentSuspense, isSVG, optimized);
			}
			if (oldLength > newLength) {
				// 旧节点数组长度大于新节点数组长度，则移除旧节点的多余的子节点
				unmountChildren(c1, parentComponent, parentSuspense, true, false, commonLength);
			}
			else {
				// 挂载新的子节点
				mountChildren(c2, container, anchor, parentComponent, parentSuspense, isSVG, optimized, commonLength);
			}
		};
		// 修补有key值的子节点 TODO
		const patchKeyedChildren = (c1, c2, container, parentAnchor, parentComponent, parentSuspense, isSVG, optimized) => {
			let i = 0;
			const l2 = c2.length;
			let e1 = c1.length - 1; // prev ending index
			let e2 = l2 - 1; // next ending index
			// 1. sync from start
			// (a b) c
			// (a b) d e
			while (i <= e1 && i <= e2) {
				const n1 = c1[i];
				const n2 = (c2[i] = optimized
					? cloneIfMounted(c2[i])
					: normalizeVNode(c2[i]));
				if (isSameVNodeType(n1, n2)) {
					patch(n1, n2, container, null, parentComponent, parentSuspense, isSVG, optimized);
				}
				else {
					break;
				}
				i++;
			}
			// 2. sync from end
			// a (b c)
			// d e (b c)
			while (i <= e1 && i <= e2) {
				const n1 = c1[e1];
				const n2 = (c2[e2] = optimized
					? cloneIfMounted(c2[e2])
					: normalizeVNode(c2[e2]));
				if (isSameVNodeType(n1, n2)) {
					patch(n1, n2, container, null, parentComponent, parentSuspense, isSVG, optimized);
				}
				else {
					break;
				}
				e1--;
				e2--;
			}
			// 3. common sequence + mount
			// (a b)
			// (a b) c
			// i = 2, e1 = 1, e2 = 2
			// (a b)
			// c (a b)
			// i = 0, e1 = -1, e2 = 0
			if (i > e1) {
				if (i <= e2) {
					const nextPos = e2 + 1;
					const anchor = nextPos < l2 ? c2[nextPos].el : parentAnchor;
					while (i <= e2) {
						patch(null, (c2[i] = optimized
							? cloneIfMounted(c2[i])
							: normalizeVNode(c2[i])), container, anchor, parentComponent, parentSuspense, isSVG);
						i++;
					}
				}
			}
			// 4. common sequence + unmount
			// (a b) c
			// (a b)
			// i = 2, e1 = 2, e2 = 1
			// a (b c)
			// (b c)
			// i = 0, e1 = 0, e2 = -1
			else if (i > e2) {
				while (i <= e1) {
					unmount(c1[i], parentComponent, parentSuspense, true);
					i++;
				}
			}
			// 5. unknown sequence
			// [i ... e1 + 1]: a b [c d e] f g
			// [i ... e2 + 1]: a b [e d c h] f g
			// i = 2, e1 = 4, e2 = 5
			else {
				const s1 = i; // prev starting index
				const s2 = i; // next starting index
				// 5.1 build key:index map for newChildren
				const keyToNewIndexMap = new Map();
				for (i = s2; i <= e2; i++) {
					const nextChild = (c2[i] = optimized
						? cloneIfMounted(c2[i])
						: normalizeVNode(c2[i]));
					if (nextChild.key != null) {
						if (keyToNewIndexMap.has(nextChild.key)) {
							warn(`Duplicate keys found during update:`, JSON.stringify(nextChild.key), `Make sure keys are unique.`);
						}
						keyToNewIndexMap.set(nextChild.key, i);
					}
				}
				// 5.2 loop through old children left to be patched and try to patch
				// matching nodes & remove nodes that are no longer present
				let j;
				let patched = 0;
				const toBePatched = e2 - s2 + 1;
				let moved = false;
				// used to track whether any node has moved
				let maxNewIndexSoFar = 0;
				// works as Map<newIndex, oldIndex>
				// Note that oldIndex is offset by +1
				// and oldIndex = 0 is a special value indicating the new node has
				// no corresponding old node.
				// used for determining longest stable subsequence
				const newIndexToOldIndexMap = new Array(toBePatched);
				for (i = 0; i < toBePatched; i++)
					newIndexToOldIndexMap[i] = 0;
				for (i = s1; i <= e1; i++) {
					const prevChild = c1[i];
					if (patched >= toBePatched) {
						// all new children have been patched so this can only be a removal
						unmount(prevChild, parentComponent, parentSuspense, true);
						continue;
					}
					let newIndex;
					if (prevChild.key != null) {
						newIndex = keyToNewIndexMap.get(prevChild.key);
					}
					else {
						// key-less node, try to locate a key-less node of the same type
						for (j = s2; j <= e2; j++) {
							if (newIndexToOldIndexMap[j - s2] === 0 &&
								isSameVNodeType(prevChild, c2[j])) {
								newIndex = j;
								break;
							}
						}
					}
					if (newIndex === undefined) {
						unmount(prevChild, parentComponent, parentSuspense, true);
					}
					else {
						newIndexToOldIndexMap[newIndex - s2] = i + 1;
						if (newIndex >= maxNewIndexSoFar) {
							maxNewIndexSoFar = newIndex;
						}
						else {
							moved = true;
						}
						patch(prevChild, c2[newIndex], container, null, parentComponent, parentSuspense, isSVG, optimized);
						patched++;
					}
				}
				// 5.3 move and mount
				// generate longest stable subsequence only when nodes have moved
				const increasingNewIndexSequence = moved
					? getSequence(newIndexToOldIndexMap)
					: EMPTY_ARR;
				j = increasingNewIndexSequence.length - 1;
				// looping backwards so that we can use last patched node as anchor
				for (i = toBePatched - 1; i >= 0; i--) {
					const nextIndex = s2 + i;
					const nextChild = c2[nextIndex];
					const anchor = nextIndex + 1 < l2 ? c2[nextIndex + 1].el : parentAnchor;
					if (newIndexToOldIndexMap[i] === 0) {
						// mount new
						patch(null, nextChild, container, anchor, parentComponent, parentSuspense, isSVG);
					}
					else if (moved) {
						// move if:
						// There is no stable subsequence (e.g. a reverse)
						// OR current node is not among the stable sequence
						if (j < 0 || i !== increasingNewIndexSequence[j]) {
							move(nextChild, container, anchor, 2 /* REORDER */);
						}
						else {
							j--;
						}
					}
				}
			}
		};
		// 移动vnode到容器下
		const move = (vnode, container, anchor, moveType, parentSuspense = null) => {
			const { el, type, transition, children, shapeFlag } = vnode;
			if (shapeFlag & 6 /* COMPONENT */) {
				move(vnode.component.subTree, container, anchor, moveType);
				return;
			}
			if (shapeFlag & 128 /* SUSPENSE */) {
				vnode.suspense.move(container, anchor, moveType);
				return;
			}
			if (shapeFlag & 64 /* TELEPORT */) {
				type.move(vnode, container, anchor, internals);
				return;
			}
			if (type === Fragment) {
				hostInsert(el, container, anchor);
				for (let i = 0; i < children.length; i++) {
					move(children[i], container, anchor, moveType);
				}
				hostInsert(vnode.anchor, container, anchor);
				return;
			}
			if (type === Static) {
				moveStaticNode(vnode, container, anchor);
				return;
			}
			// 是否需要过渡
			const needTransition = moveType !== 2 /* REORDER */ &&
				shapeFlag & 1 /* ELEMENT */ &&
				transition;
			if (needTransition) {
				if (moveType === 0 /* ENTER */) {
					transition.beforeEnter(el);
					hostInsert(el, container, anchor);
					queuePostRenderEffect(() => transition.enter(el), parentSuspense);
				}
				else {
					const { leave, delayLeave, afterLeave } = transition;
					const remove = () => hostInsert(el, container, anchor);
					const performLeave = () => {
						leave(el, () => {
							remove();
							afterLeave && afterLeave();
						});
					};
					if (delayLeave) {
						delayLeave(el, remove, performLeave);
					}
					else {
						performLeave();
					}
				}
			}
			else {
				hostInsert(el, container, anchor);
			}
		};
		// 卸载
		const unmount = (vnode, parentComponent, parentSuspense, doRemove = false, optimized = false) => {
			const { type, props, ref, children, dynamicChildren, shapeFlag, patchFlag, dirs } = vnode;
			// 卸载 ref
			if (ref != null && parentComponent) {
				setRef(ref, null, parentComponent, parentSuspense, null);
			}
			if (shapeFlag & 256 /* COMPONENT_SHOULD_KEEP_ALIVE */) {
				parentComponent.ctx.deactivate(vnode);
				return;
			}
			const shouldInvokeDirs = shapeFlag & 1 /* ELEMENT */ && dirs;
			let vnodeHook;
			// onVnodeBeforeUnmount
			if ((vnodeHook = props && props.onVnodeBeforeUnmount)) {
				invokeVNodeHook(vnodeHook, parentComponent, vnode);
			}
			if (shapeFlag & 6 /* COMPONENT */) {
				unmountComponent(vnode.component, parentSuspense, doRemove);
			}
			else {
				if (shapeFlag & 128 /* SUSPENSE */) {
					vnode.suspense.unmount(parentSuspense, doRemove);
					return;
				}
				if (shouldInvokeDirs) {
					// 触发自定义指令的beforeUnmount钩子
					invokeDirectiveHook(vnode, null, parentComponent, 'beforeUnmount');
				}
				if (dynamicChildren &&
					(type !== Fragment ||
						(patchFlag > 0 && patchFlag & 64 /* STABLE_FRAGMENT */))) {
					// 卸载子组件
					unmountChildren(dynamicChildren, parentComponent, parentSuspense, false, true);
				}
				else if ((type === Fragment &&
					(patchFlag & 128 /* KEYED_FRAGMENT */ ||
						patchFlag & 256 /* UNKEYED_FRAGMENT */)) ||
					(!optimized && shapeFlag & 16 /* ARRAY_CHILDREN */)) {
					unmountChildren(children, parentComponent, parentSuspense);
				}
				if (shapeFlag & 64 /* TELEPORT */ &&
					(doRemove || !isTeleportDisabled(vnode.props))) {
					vnode.type.remove(vnode, internals);
				}
				if (doRemove) {
					remove(vnode);
				}
			}
			// 触发钩子
			if ((vnodeHook = props && props.onVnodeUnmounted) || shouldInvokeDirs) {
				queuePostRenderEffect(() => {
					vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
					shouldInvokeDirs &&
						invokeDirectiveHook(vnode, null, parentComponent, 'unmounted');
				}, parentSuspense);
			}
		};
		// 移除vnode
		const remove = vnode => {
			const { type, el, anchor, transition } = vnode;
			if (type === Fragment) {
				// 移除Fragment
				removeFragment(el, anchor);
				return;
			}
			if (type === Static) {
				removeStaticNode(vnode);
				return;
			}
			const performRemove = () => {
				hostRemove(el);
				if (transition && !transition.persisted && transition.afterLeave) {
					transition.afterLeave();
				}
			};
			if (vnode.shapeFlag & 1 /* ELEMENT */ &&
				transition &&
				!transition.persisted) {
				const { leave, delayLeave } = transition;
				const performLeave = () => leave(el, performRemove);
				if (delayLeave) {
					delayLeave(vnode.el, performRemove, performLeave);
				}
				else {
					performLeave();
				}
			}
			else {
				performRemove();
			}
		};
		// 移除Fragment
		const removeFragment = (cur, end) => {
			let next;
			while (cur !== end) {
				next = hostNextSibling(cur);
				hostRemove(cur);
				cur = next;
			}
			hostRemove(end);
		};
		// 卸载组件
		const unmountComponent = (instance, parentSuspense, doRemove) => {
			if (instance.type.__hmrId) {
				unregisterHMR(instance);
			}
			const { bum, effects, update, subTree, um } = instance;
			if (bum) {
				// -------------------------beforeUnmount生命周期钩子
				invokeArrayFns(bum);
			}
			if (effects) {
				for (let i = 0; i < effects.length; i++) {
					// 停止所有effect
					stop(effects[i]);
				}
			}
			if (update) {
				stop(update);
				unmount(subTree, instance, parentSuspense, doRemove);
			}
			if (um) {
				// -----------------------------unmounted生命周期钩子
				queuePostRenderEffect(um, parentSuspense);
			}
			queuePostRenderEffect(() => {
				instance.isUnmounted = true;
			}, parentSuspense);
			if (
				parentSuspense &&
				parentSuspense.pendingBranch &&
				!parentSuspense.isUnmounted &&
				instance.asyncDep &&
				!instance.asyncResolved &&
				instance.suspenseId === parentSuspense.pendingId) {
				parentSuspense.deps--;
				if (parentSuspense.deps === 0) {
					parentSuspense.resolve();
				}
			}
			{
				devtoolsComponentRemoved(instance);
			}
		};
		// 卸载组件
		const unmountChildren = (children, parentComponent, parentSuspense, doRemove = false, optimized = false, start = 0) => {
			for (let i = start; i < children.length; i++) {
				unmount(children[i], parentComponent, parentSuspense, doRemove, optimized);
			}
		};
		// 获取写一个子节点
		const getNextHostNode = vnode => {
			if (vnode.shapeFlag & 6 /* COMPONENT */) {
				return getNextHostNode(vnode.component.subTree);
			}
			if (vnode.shapeFlag & 128 /* SUSPENSE */) {
				return vnode.suspense.next();
			}
			return hostNextSibling((vnode.anchor || vnode.el));
		};
		// render函数
		const render = (vnode, container) => {
			if (vnode == null) {
				if (container._vnode) {
					unmount(container._vnode, null, null, true);
				}
			}
			else {
				patch(container._vnode || null, vnode, container);
			}
			flushPostFlushCbs();
			container._vnode = vnode;
		};
		const internals = {
			p: patch,
			um: unmount,
			m: move,
			r: remove,
			mt: mountComponent,
			mc: mountChildren,
			pc: patchChildren,
			pbc: patchBlockChildren,
			n: getNextHostNode,
			o: options
		};
		let hydrate;
		let hydrateNode;
		if (createHydrationFns) {
			[hydrate, hydrateNode] = createHydrationFns(internals);
		}
		return {
			render,
			hydrate,
			createApp: createAppAPI(render, hydrate)
		};
	}
	// 触发hook
	function invokeVNodeHook(hook, instance, vnode, prevVNode = null) {
		callWithAsyncErrorHandling(hook, instance, 7 /* VNODE_HOOK */, [
			vnode,
			prevVNode
		]);
	}
	// 深度创建静态子节点
	function traverseStaticChildren(n1, n2, shallow = false) {
		const ch1 = n1.children;
		const ch2 = n2.children;
		if (isArray(ch1) && isArray(ch2)) {
			for (let i = 0; i < ch1.length; i++) {
				const c1 = ch1[i];
				let c2 = ch2[i];
				if (c2.shapeFlag & 1 /* ELEMENT */ && !c2.dynamicChildren) {
					if (c2.patchFlag <= 0 || c2.patchFlag === 32 /* HYDRATE_EVENTS */) {
						c2 = ch2[i] = cloneIfMounted(ch2[i]);
						c2.el = c1.el;
					}
					if (!shallow)
						traverseStaticChildren(c1, c2);
				}
				if (c2.type === Comment && !c2.el) {
					c2.el = c1.el;
				}
			}
		}
	}
	// https://en.wikipedia.org/wiki/Longest_increasing_subsequence
	function getSequence(arr) {
		const p = arr.slice();
		const result = [0];
		let i, j, u, v, c;
		const len = arr.length;
		for (i = 0; i < len; i++) {
			const arrI = arr[i];
			if (arrI !== 0) {
				j = result[result.length - 1];
				if (arr[j] < arrI) {
					p[i] = j;
					result.push(i);
					continue;
				}
				u = 0;
				v = result.length - 1;
				while (u < v) {
					c = ((u + v) / 2) | 0;
					if (arr[result[c]] < arrI) {
						u = c + 1;
					}
					else {
						v = c;
					}
				}
				if (arrI < arr[result[u]]) {
					if (u > 0) {
						p[i] = result[u - 1];
					}
					result[u] = i;
				}
			}
		}
		u = result.length;
		v = result[u - 1];
		while (u-- > 0) {
			result[u] = v;
			v = p[v];
		}
		return result;
	}

	// Teleport组件，控制HTML在哪个DOM节点下渲染
	// 判断组件是否为teleport组件
	const isTeleport = (type) => type.__isTeleport;
	// 判断Teleport组件是否含有disabled prop
	const isTeleportDisabled = (props) => props && (props.disabled || props.disabled === '');
	const resolveTarget = (props, select) => {
		const targetSelector = props && props.to;
		if (isString(targetSelector)) {
			if (!select) {

				warn(`Current renderer does not support string target for Teleports. ` +
					`(missing querySelector renderer option)`);
				return null;
			}
			else {
				const target = select(targetSelector);
				if (!target) {

					warn(`Failed to locate Teleport target with selector "${targetSelector}". ` +
						`Note the target element must exist before the component is mounted - ` +
						`i.e. the target cannot be rendered by the component itself, and ` +
						`ideally should be outside of the entire Vue component tree.`);
				}
				return target;
			}
		}
		else {
			if (!targetSelector && !isTeleportDisabled(props)) {
				warn(`Invalid Teleport target: ${targetSelector}`);
			}
			return targetSelector;
		}
	};
	const TeleportImpl = {
		__isTeleport: true,
		process(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized, internals) {
			const { mc: mountChildren, pc: patchChildren, pbc: patchBlockChildren, o: { insert, querySelector, createText, createComment } } = internals;
			const disabled = isTeleportDisabled(n2.props);
			const { shapeFlag, children } = n2;
			if (n1 == null) {
				// insert anchors in the main view
				const placeholder = (n2.el = createComment('teleport start')
				);
				const mainAnchor = (n2.anchor = createComment('teleport end')
				);
				insert(placeholder, container, anchor);
				insert(mainAnchor, container, anchor);
				const target = (n2.target = resolveTarget(n2.props, querySelector));
				const targetAnchor = (n2.targetAnchor = createText(''));
				if (target) {
					insert(targetAnchor, target);
				}
				else if (!disabled) {
					warn('Invalid Teleport target on mount:', target, `(${typeof target})`);
				}
				const mount = (container, anchor) => {
					// Teleport *always* has Array children. This is enforced in both the
					// compiler and vnode children normalization.
					if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
						mountChildren(children, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
					}
				};
				if (disabled) {
					mount(container, mainAnchor);
				}
				else if (target) {
					mount(target, targetAnchor);
				}
			}
			else {
				// update content
				n2.el = n1.el;
				const mainAnchor = (n2.anchor = n1.anchor);
				const target = (n2.target = n1.target);
				const targetAnchor = (n2.targetAnchor = n1.targetAnchor);
				const wasDisabled = isTeleportDisabled(n1.props);
				const currentContainer = wasDisabled ? container : target;
				const currentAnchor = wasDisabled ? mainAnchor : targetAnchor;
				if (n2.dynamicChildren) {
					// fast path when the teleport happens to be a block root
					patchBlockChildren(n1.dynamicChildren, n2.dynamicChildren, currentContainer, parentComponent, parentSuspense, isSVG);
					// even in block tree mode we need to make sure all root-level nodes
					// in the teleport inherit previous DOM references so that they can
					// be moved in future patches.
					traverseStaticChildren(n1, n2, true);
				}
				else if (!optimized) {
					patchChildren(n1, n2, currentContainer, currentAnchor, parentComponent, parentSuspense, isSVG);
				}
				if (disabled) {
					if (!wasDisabled) {
						// enabled -> disabled
						// move into main container
						moveTeleport(n2, container, mainAnchor, internals, 1 /* TOGGLE */);
					}
				}
				else {
					// target changed
					if ((n2.props && n2.props.to) !== (n1.props && n1.props.to)) {
						const nextTarget = (n2.target = resolveTarget(n2.props, querySelector));
						if (nextTarget) {
							moveTeleport(n2, nextTarget, null, internals, 0 /* TARGET_CHANGE */);
						}
						else {
							warn('Invalid Teleport target on update:', target, `(${typeof target})`);
						}
					}
					else if (wasDisabled) {
						// disabled -> enabled
						// move into teleport target
						moveTeleport(n2, target, targetAnchor, internals, 1 /* TOGGLE */);
					}
				}
			}
		},
		remove(vnode, { r: remove, o: { remove: hostRemove } }) {
			const { shapeFlag, children, anchor } = vnode;
			hostRemove(anchor);
			if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
				for (let i = 0; i < children.length; i++) {
					remove(children[i]);
				}
			}
		},
		move: moveTeleport,
		hydrate: hydrateTeleport
	};
	function moveTeleport(vnode, container, parentAnchor, { o: { insert }, m: move }, moveType = 2 /* REORDER */) {
		// move target anchor if this is a target change.
		if (moveType === 0 /* TARGET_CHANGE */) {
			insert(vnode.targetAnchor, container, parentAnchor);
		}
		const { el, anchor, shapeFlag, children, props } = vnode;
		const isReorder = moveType === 2 /* REORDER */;
		// move main view anchor if this is a re-order.
		if (isReorder) {
			insert(el, container, parentAnchor);
		}
		// if this is a re-order and teleport is enabled (content is in target)
		// do not move children. So the opposite is: only move children if this
		// is not a reorder, or the teleport is disabled
		if (!isReorder || isTeleportDisabled(props)) {
			// Teleport has either Array children or no children.
			if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
				for (let i = 0; i < children.length; i++) {
					move(children[i], container, parentAnchor, 2 /* REORDER */);
				}
			}
		}
		// move main view anchor if this is a re-order.
		if (isReorder) {
			insert(anchor, container, parentAnchor);
		}
	}
	function hydrateTeleport(node, vnode, parentComponent, parentSuspense, optimized, { o: { nextSibling, parentNode, querySelector } }, hydrateChildren) {
		const target = (vnode.target = resolveTarget(vnode.props, querySelector));
		if (target) {
			const targetNode = target._lpa || target.firstChild;
			if (vnode.shapeFlag & 16 /* ARRAY_CHILDREN */) {
				if (isTeleportDisabled(vnode.props)) {
					vnode.anchor = hydrateChildren(nextSibling(node), vnode, parentNode(node), parentComponent, parentSuspense, optimized);
					vnode.targetAnchor = targetNode;
				}
				else {
					vnode.anchor = nextSibling(node);
					vnode.targetAnchor = hydrateChildren(targetNode, vnode, target, parentComponent, parentSuspense, optimized);
				}
				target._lpa =
					vnode.targetAnchor && nextSibling(vnode.targetAnchor);
			}
		}
		return vnode.anchor && nextSibling(vnode.anchor);
	}
	const Teleport = TeleportImpl;

	const COMPONENTS = 'components';
	const DIRECTIVES = 'directives';
	/**
	 * 根据标签名解析组件
	 * @private
	 */
	function resolveComponent(name) {
		return resolveAsset(COMPONENTS, name) || name;
	}
	const NULL_DYNAMIC_COMPONENT = Symbol();
	/**
	 * 解析动态组件
	 * @private
	 */
	function resolveDynamicComponent(component) {
		if (isString(component)) {
			return resolveAsset(COMPONENTS, component, false) || component;
		}
		else {
			return (component || NULL_DYNAMIC_COMPONENT);
		}
	}
	// 解析自定义指令
	function resolveDirective(name) {
		return resolveAsset(DIRECTIVES, name);
	}
	// 解析静态资源（component、directives）
	function resolveAsset(type, name, warnMissing = true) {
		const instance = currentRenderingInstance || currentInstance;
		if (instance) {
			const Component = instance.type;
			if (type === COMPONENTS) {
				const selfName = Component.displayName || Component.name;
				if (selfName &&
					(selfName === name ||
						selfName === camelize(name) ||
						selfName === capitalize(camelize(name)))) {
					return Component;
				}
			}
			const res =
				resolve(instance[type] || Component[type], name) ||
				resolve(instance.appContext[type], name);
			if (warnMissing && !res) {
				warn(`Failed to resolve ${type.slice(0, -1)}: ${name}`);
			}
			return res;
		}
		else {
			warn(`resolve${capitalize(type.slice(0, -1))} ` +
				`can only be used in render() or setup().`);
		}
	}
	function resolve(registry, name) {
		return (registry &&
			(registry[name] ||
				registry[camelize(name)] ||
				registry[capitalize(camelize(name))]));
	}

	const Fragment = Symbol('Fragment');
	const Text = Symbol('Text');
	const Comment = Symbol('Comment');
	const Static = Symbol('Static');
	const blockStack = [];
	let currentBlock = null;
	// 打开block
	function openBlock(disableTracking = false) {
		blockStack.push((currentBlock = disableTracking ? null : []));
	}
	// 关闭block
	function closeBlock() {
		blockStack.pop();
		currentBlock = blockStack[blockStack.length - 1] || null;
	}
	let shouldTrack$1 = 1;
	// 设置block跟踪
	function setBlockTracking(value) {
		shouldTrack$1 += value;
	}
	// 创建一个块节点
	function createBlock(type, props, children, patchFlag, dynamicProps) {
		const vnode = createVNode(type, props, children, patchFlag, dynamicProps, true /* isBlock: prevent a block from tracking itself */);
		vnode.dynamicChildren = currentBlock || EMPTY_ARR;
		closeBlock();
		if (shouldTrack$1 > 0 && currentBlock) {
			currentBlock.push(vnode);
		}
		return vnode;
	}
	// 判断传入参数是否为vnode
	function isVNode(value) {
		return value ? value.__v_isVNode === true : false;
	}
	// 判断两个node节点是否相等
	function isSameVNodeType(n1, n2) {
		if (
			n2.shapeFlag & 6 /* COMPONENT */ &&
			hmrDirtyComponents.has(n2.type)) {
			return false;
		}
		return n1.type === n2.type && n1.key === n2.key;
	}
	let vnodeArgsTransformer;
	function transformVNodeArgs(transformer) {
		vnodeArgsTransformer = transformer;
	}
	const createVNodeWithArgsTransform = (...args) => {
		return _createVNode(...(vnodeArgsTransformer
			? vnodeArgsTransformer(args, currentRenderingInstance)
			: args));
	};

	// 标记对象key值是否为内置的（浏览器自带的）
	const InternalObjectKey = `__vInternal`;
	// 格式化key
	const normalizeKey = ({ key }) => key != null ? key : null;
	// 格式化ref
	const normalizeRef = ({ ref }) => {
		return (ref != null
			? isArray(ref)
				? ref
				: { i: currentRenderingInstance, r: ref }
			: null);
	};
	const createVNode = (createVNodeWithArgsTransform
	);
	// 私有方法，创建VNode
	function _createVNode(type, props = null, children = null, patchFlag = 0, dynamicProps = null, isBlockNode = false) {
		if (!type || type === NULL_DYNAMIC_COMPONENT) {
			if (!type) {
				warn(`Invalid vnode type when creating vnode: ${type}.`);
			}
			type = Comment;
		}
		// TODO type在什么情况下为VNode类型
		if (isVNode(type)) {
			const cloned = cloneVNode(type, props, true /* mergeRef: true */);
			if (children) {
				normalizeChildren(cloned, children);
			}
			return cloned;
		}
		// TODO type在什么情况下为类组件
		if (isClassComponent(type)) {
			type = type.__vccOpts;
		}
		// TODO props存在
		if (props) {
			// for reactive or proxy objects, we need to clone it to enable mutation.
			if (isProxy(props) || InternalObjectKey in props) {
				props = extend({}, props);
			}
			let { class: klass, style } = props;
			if (klass && !isString(klass)) {
				props.class = normalizeClass(klass);
			}
			if (isObject(style)) {
				// reactive state objects need to be cloned since they are likely to be
				// mutated
				if (isProxy(style) && !isArray(style)) {
					style = extend({}, style);
				}
				props.style = normalizeStyle(style);
			}
		}
		// 将VNode类型信息编码添加到位图中
		const shapeFlag = isString(type)
			? 1 /* ELEMENT */
			: isSuspense(type)
				? 128 /* SUSPENSE */
				: isTeleport(type)
					? 64 /* TELEPORT */
					: isObject(type)
						? 4 /* STATEFUL_COMPONENT 有状态的组件，即在生命周期内可以被多次绘制 */
						: isFunction(type)
							? 2 /* FUNCTIONAL_COMPONENT */
							: 0;
		// 如果type为proxy对象，则输出警告信息，并将type转成原始对象
		if (shapeFlag & 4 /* STATEFUL_COMPONENT */ && isProxy(type)) {
			type = toRaw(type);
			warn(`Vue received a Component which was made a reactive object. This can ` +
				`lead to unnecessary performance overhead, and should be avoided by ` +
				`marking the component with \`markRaw\` or using \`shallowRef\` ` +
				`instead of \`ref\`.`, `\nComponent that was made reactive: `, type);
		}
		const vnode = {
			__v_isVNode: true,
			["__v_skip" /* SKIP */]: true,
			type,
			props,
			key: props && normalizeKey(props),
			ref: props && normalizeRef(props),
			scopeId: currentScopeId,
			children: null,
			component: null,
			suspense: null,
			ssContent: null,
			ssFallback: null,
			dirs: null,
			transition: null,
			el: null,
			anchor: null,
			target: null,
			targetAnchor: null,
			staticCount: 0,
			shapeFlag,
			patchFlag,
			dynamicProps,
			dynamicChildren: null,
			appContext: null
		};
		// 校验key值，NaN 不等于 NaN
		if (vnode.key !== vnode.key) {
			warn(`VNode created with invalid key (NaN). VNode type:`, vnode.type);
		}
		// 格式化子节点
		normalizeChildren(vnode, children);
		// 格式化suspense类型的子节点
		if (shapeFlag & 128 /* SUSPENSE */) {
			const { content, fallback } = normalizeSuspenseChildren(vnode);
			vnode.ssContent = content;
			vnode.ssFallback = fallback;
		}
		if (shouldTrack$1 > 0 &&
			!isBlockNode &&
			currentBlock &&
			(patchFlag > 0 || shapeFlag & 6 /* COMPONENT */) &&
			patchFlag !== 32 /* HYDRATE_EVENTS */) {
			currentBlock.push(vnode);
		}
		return vnode;
	}
	// 克隆vnode
	function cloneVNode(vnode, extraProps, mergeRef = false) {
		const { props, ref, patchFlag } = vnode;
		const mergedProps = extraProps ? mergeProps(props || {}, extraProps) : props;
		return {
			__v_isVNode: true,
			["__v_skip" /* SKIP */]: true,
			type: vnode.type,
			props: mergedProps,
			key: mergedProps && normalizeKey(mergedProps),
			ref: extraProps && extraProps.ref
				?
				mergeRef && ref
					? isArray(ref)
						? ref.concat(normalizeRef(extraProps))
						: [ref, normalizeRef(extraProps)]
					: normalizeRef(extraProps)
				: ref,
			scopeId: vnode.scopeId,
			children: vnode.children,
			target: vnode.target,
			targetAnchor: vnode.targetAnchor,
			staticCount: vnode.staticCount,
			shapeFlag: vnode.shapeFlag,
			patchFlag: extraProps && vnode.type !== Fragment
				? patchFlag === -1 // hoisted node
					? 16 /* FULL_PROPS */
					: patchFlag | 16 /* FULL_PROPS */
				: patchFlag,
			dynamicProps: vnode.dynamicProps,
			dynamicChildren: vnode.dynamicChildren,
			appContext: vnode.appContext,
			dirs: vnode.dirs,
			transition: vnode.transition,
			component: vnode.component,
			suspense: vnode.suspense,
			ssContent: vnode.ssContent && cloneVNode(vnode.ssContent),
			ssFallback: vnode.ssFallback && cloneVNode(vnode.ssFallback),
			el: vnode.el,
			anchor: vnode.anchor
		};
	}
	// 创建文本节点
	function createTextVNode(text = ' ', flag = 0) {
		return createVNode(Text, null, text, flag);
	}
	// 创建静态节点
	function createStaticVNode(content, numberOfNodes) {
		const vnode = createVNode(Static, null, content);
		vnode.staticCount = numberOfNodes;
		return vnode;
	}
	// 创建注释节点
	function createCommentVNode(text = '',
		asBlock = false) {
		return asBlock
			? (openBlock(), createBlock(Comment, null, text))
			: createVNode(Comment, null, text);
	}
	// 格式化VNode
	function normalizeVNode(child) {
		if (child == null || typeof child === 'boolean') {
			return createVNode(Comment);
		}
		else if (isArray(child)) {
			// fragment
			return createVNode(Fragment, null, child);
		}
		else if (typeof child === 'object') {
			// new Function创建的vnode
			return child.el === null ? child : cloneVNode(child);
		}
		else {
			// strings and numbers
			return createVNode(Text, null, String(child));
		}
	}
	// 克隆节点
	function cloneIfMounted(child) {
		return child.el === null ? child : cloneVNode(child);
	}
	// 格式化子节点
	function normalizeChildren(vnode, children) {
		let type = 0;
		const { shapeFlag } = vnode;
		if (children == null) {
			children = null;
		}
		else if (isArray(children)) {
			type = 16 /* ARRAY_CHILDREN ---- 数组类型的子节点 */;
		}
		else if (typeof children === 'object') {
			// 标签或者Teleport组件
			if (shapeFlag & 1 /* ELEMENT */ || shapeFlag & 64 /* TELEPORT */) {
				const slot = children.default;
				if (slot) {
					slot._c && setCompiledSlotRendering(1);
					normalizeChildren(vnode, slot());
					slot._c && setCompiledSlotRendering(-1);
				}
				return;
			}
			else {
				// 插槽类型的子节点
				type = 32 /* SLOTS_CHILDREN */;
				const slotFlag = children._;
				if (!slotFlag && !(InternalObjectKey in children)) {
					children._ctx = currentRenderingInstance;
				}
				else if (slotFlag === 3 /* FORWARDED ---- 拥有深层插槽 */ && currentRenderingInstance) {
					// 动态插槽
					if (currentRenderingInstance.vnode.patchFlag & 1024 /* DYNAMIC_SLOTS */) {
						children._ = 2 /* DYNAMIC */;
						vnode.patchFlag |= 1024 /* DYNAMIC_SLOTS */;
					}
					// 具名插槽
					else {
						children._ = 1 /* STABLE */;
					}
				}
			}
		}
		else if (isFunction(children)) {
			children = { default: children, _ctx: currentRenderingInstance };
			type = 32 /* SLOTS_CHILDREN */;
		}
		else {
			children = String(children);
			if (shapeFlag & 64 /* TELEPORT */) {
				type = 16 /* ARRAY_CHILDREN */;
				children = [createTextVNode(children)];
			}
			else {
				// 默认为字符串类型
				type = 8 /* TEXT_CHILDREN */;
			}
		}
		vnode.children = children;
		// shapeFlag在这里会改变
		// e.g. 1 | 8 = 9
		vnode.shapeFlag |= type;
	}
	// 合并props
	function mergeProps(...args) {
		const ret = extend({}, args[0]);
		for (let i = 1; i < args.length; i++) {
			const toMerge = args[i];
			for (const key in toMerge) {
				if (key === 'class') {
					if (ret.class !== toMerge.class) {
						ret.class = normalizeClass([ret.class, toMerge.class]);
					}
				}
				else if (key === 'style') {
					ret.style = normalizeStyle([ret.style, toMerge.style]);
				}
				else if (isOn(key)) {
					const existing = ret[key];
					const incoming = toMerge[key];
					if (existing !== incoming) {
						ret[key] = existing
							? [].concat(existing, toMerge[key])
							: incoming;
					}
				}
				else if (key !== '') {
					ret[key] = toMerge[key];
				}
			}
		}
		return ret;
	}
	// provide
	function provide(key, value) {
		if (!currentInstance) {
			{
				warn(`provide() can only be used inside setup().`);
			}
		}
		else {
			let provides = currentInstance.provides;
			const parentProvides = currentInstance.parent && currentInstance.parent.provides;
			if (parentProvides === provides) {
				provides = currentInstance.provides = Object.create(parentProvides);
			}
			provides[key] = value;
		}
	}
	// inject
	function inject(key, defaultValue, treatDefaultAsFactory = false) {
		const instance = currentInstance || currentRenderingInstance;
		if (instance) {
			const provides = instance.parent == null
				? instance.vnode.appContext && instance.vnode.appContext.provides
				: instance.parent.provides;
			if (provides && key in provides) {
				// TS 不支持symbol作为index type
				// 直接返回provides的属性值
				return provides[key];
			}
			else if (arguments.length > 1) {
				return treatDefaultAsFactory && isFunction(defaultValue)
					? defaultValue()
					: defaultValue;
			}
			else {
				warn(`injection "${String(key)}" not found.`);
			}
		}
		else {
			warn(`inject() can only be used inside setup() or functional components.`);
		}
	}

	// 创建检查重复属性，如果有重复属性，则抛出警告
	function createDuplicateChecker() {
		const cache = Object.create(null);
		return (type, key) => {
			if (cache[key]) {
				warn(`${type} property "${key}" is already defined in ${cache[key]}.`);
			}
			else {
				cache[key] = type;
			}
		};
	}
	// 是否正在beforeCreate生命周期
	let isInBeforeCreate = false;
	// 应用程序员传递的options
	function applyOptions(instance, options, deferredData = [], deferredWatch = [], deferredProvide = [], asMixin = false) {
		const {
			// composition
			mixins, extends: extendsOptions,
			// state
			data: dataOptions, computed: computedOptions, methods, watch: watchOptions, provide: provideOptions, inject: injectOptions,
			// assets
			components, directives,
			// lifecycle
			beforeMount, mounted, beforeUpdate, updated, activated, deactivated, beforeDestroy, beforeUnmount, destroyed, unmounted, render, renderTracked, renderTriggered, errorCaptured } = options;
		const publicThis = instance.proxy;
		const ctx = instance.ctx;
		const globalMixins = instance.appContext.mixins;
		if (asMixin && render && instance.render === NOOP) {
			instance.render = render;
		}
		if (!asMixin) {
			isInBeforeCreate = true;
			// -------------------beforeCreate生命周期
			callSyncHook('beforeCreate', "bc" /* BEFORE_CREATE */, options, instance, globalMixins);
			isInBeforeCreate = false;
			// 全局的mixins
			applyMixins(instance, globalMixins, deferredData, deferredWatch, deferredProvide);
		}
		// 先执行mixins再执行extends
		// extends
		if (extendsOptions) {
			applyOptions(instance, extendsOptions, deferredData, deferredWatch, deferredProvide, true);
		}
		// 局部的mixins
		if (mixins) {
			applyMixins(instance, mixins, deferredData, deferredWatch, deferredProvide);
		}
		// 检查是否存在重复的属性
		const checkDuplicateProperties = createDuplicateChecker();
		{
			// 检查props
			const [propsOptions] = instance.propsOptions;
			if (propsOptions) {
				for (const key in propsOptions) {
					checkDuplicateProperties("Props" /* PROPS */, key);
				}
			}
		}
		if (injectOptions) {
			if (isArray(injectOptions)) {
				for (let i = 0; i < injectOptions.length; i++) {
					const key = injectOptions[i];
					ctx[key] = inject(key);
					{
						checkDuplicateProperties("Inject" /* INJECT */, key);
					}
				}
			}
			else {
				for (const key in injectOptions) {
					const opt = injectOptions[key];
					if (isObject(opt)) {
						ctx[key] = inject(opt.from || key, opt.default, true /* treat default function as factory */);
					}
					else {
						ctx[key] = inject(opt);
					}
					{
						checkDuplicateProperties("Inject" /* INJECT */, key);
					}
				}
			}
		}
		if (methods) {
			for (const key in methods) {
				const methodHandler = methods[key];
				if (isFunction(methodHandler)) {
					ctx[key] = methodHandler.bind(publicThis);
					{
						checkDuplicateProperties("Methods" /* METHODS */, key);
					}
				}
				else {
					warn(`Method "${key}" has type "${typeof methodHandler}" in the component definition. ` +
						`Did you reference the function correctly?`);
				}
			}
		}
		if (!asMixin) {
			if (deferredData.length) {
				deferredData.forEach(dataFn => resolveData(instance, dataFn, publicThis));
			}
			if (dataOptions) {
				resolveData(instance, dataOptions, publicThis);
			}
			{
				const rawData = toRaw(instance.data);
				for (const key in rawData) {
					checkDuplicateProperties("Data" /* DATA */, key);
					// 不等于私有属性时，挂载到ctx上下文上，监听属性的获取
					if (key[0] !== '$' && key[0] !== '_') {
						Object.defineProperty(ctx, key, {
							configurable: true,
							enumerable: true,
							get: () => rawData[key],
							set: NOOP
						});
					}
				}
			}
		}
		else if (dataOptions) {
			deferredData.push(dataOptions);
		}
		// computed
		if (computedOptions) {
			for (const key in computedOptions) {
				const opt = computedOptions[key];
				const get = isFunction(opt)
					? opt.bind(publicThis, publicThis)
					: isFunction(opt.get)
						? opt.get.bind(publicThis, publicThis)
						: NOOP;
				if (get === NOOP) {
					warn(`Computed property "${key}" has no getter.`);
				}
				const set = !isFunction(opt) && isFunction(opt.set)
					? opt.set.bind(publicThis)
					: () => {
						warn(`Write operation failed: computed property "${key}" is readonly.`);
					};
				// 添加监听
				const c = computed$1({
					get,
					set
				});
				Object.defineProperty(ctx, key, {
					enumerable: true,
					configurable: true,
					get: () => c.value,
					set: v => (c.value = v)
				});
				{
					checkDuplicateProperties("Computed" /* COMPUTED */, key);
				}
			}
		}
		if (watchOptions) {
			deferredWatch.push(watchOptions);
		}
		if (!asMixin && deferredWatch.length) {
			deferredWatch.forEach(watchOptions => {
				for (const key in watchOptions) {
					// 创建watcher
					createWatcher(watchOptions[key], ctx, publicThis, key);
				}
			});
		}
		if (provideOptions) {
			deferredProvide.push(provideOptions);
		}
		if (!asMixin && deferredProvide.length) {
			deferredProvide.forEach(provideOptions => {
				const provides = isFunction(provideOptions)
					? provideOptions.call(publicThis)
					: provideOptions;
				for (const key in provides) {
					provide(key, provides[key]);
				}
			});
		}
		if (asMixin) {
			if (components) {
				extend(instance.components ||
					(instance.components = extend({}, instance.type.components)), components);
			}
			if (directives) {
				extend(instance.directives ||
					(instance.directives = extend({}, instance.type.directives)), directives);
			}
		}
		if (!asMixin) {
			// -------------------created生命周期
			callSyncHook('created', "c" /* CREATED */, options, instance, globalMixins);
		}
		if (beforeMount) {
			// ------------------注册hooks
			onBeforeMount(beforeMount.bind(publicThis));
		}
		if (mounted) {
			onMounted(mounted.bind(publicThis));
		}
		if (beforeUpdate) {
			onBeforeUpdate(beforeUpdate.bind(publicThis));
		}
		if (updated) {
			onUpdated(updated.bind(publicThis));
		}
		if (activated) {
			onActivated(activated.bind(publicThis));
		}
		if (deactivated) {
			onDeactivated(deactivated.bind(publicThis));
		}
		if (errorCaptured) {
			onErrorCaptured(errorCaptured.bind(publicThis));
		}
		if (renderTracked) {
			onRenderTracked(renderTracked.bind(publicThis));
		}
		if (renderTriggered) {
			onRenderTriggered(renderTriggered.bind(publicThis));
		}
		if (beforeDestroy) {
			// beforeDestory被重命名为beforeUnmount了
			warn(`\`beforeDestroy\` has been renamed to \`beforeUnmount\`.`);
		}
		if (beforeUnmount) {
			onBeforeUnmount(beforeUnmount.bind(publicThis));
		}
		if (destroyed) {
			// destoryed被重命名为unmounted了
			warn(`\`destroyed\` has been renamed to \`unmounted\`.`);
		}
		if (unmounted) {
			onUnmounted(unmounted.bind(publicThis));
		}
	}
	// 触发同步回调hooks
	function callSyncHook(name, type, options, instance, globalMixins) {
		callHookFromMixins(name, type, globalMixins, instance);
		const { extends: base, mixins } = options;
		if (base) {
			callHookFromExtends(name, type, base, instance);
		}
		if (mixins) {
			callHookFromMixins(name, type, mixins, instance);
		}
		const selfHook = options[name];
		if (selfHook) {
			callWithAsyncErrorHandling(selfHook.bind(instance.proxy), instance, type);
		}
	}
	// 触发extends里面的hook
	function callHookFromExtends(name, type, base, instance) {
		if (base.extends) {
			callHookFromExtends(name, type, base.extends, instance);
		}
		const baseHook = base[name];
		if (baseHook) {
			callWithAsyncErrorHandling(baseHook.bind(instance.proxy), instance, type);
		}
	}
	// 触发mixins里面的hook
	function callHookFromMixins(name, type, mixins, instance) {
		for (let i = 0; i < mixins.length; i++) {
			const chainedMixins = mixins[i].mixins;
			if (chainedMixins) {
				callHookFromMixins(name, type, chainedMixins, instance);
			}
			const fn = mixins[i][name];
			if (fn) {
				callWithAsyncErrorHandling(fn.bind(instance.proxy), instance, type);
			}
		}
	}
	// 应用mixins
	function applyMixins(instance, mixins, deferredData, deferredWatch, deferredProvide) {
		for (let i = 0; i < mixins.length; i++) {
			applyOptions(instance, mixins[i], deferredData, deferredWatch, deferredProvide, true);
		}
	}
	// 解析data
	function resolveData(instance, dataFn, publicThis) {
		if (!isFunction(dataFn)) {
			warn(`The data option must be a function. ` +
				`Plain object usage is no longer supported.`);
		}
		const data = dataFn.call(publicThis, publicThis);
		if (isPromise(data)) {
			warn(`data() returned a Promise - note data() cannot be async; If you ` +
				`intend to perform data fetching before component renders, use ` +
				`async setup() + <Suspense>.`);
		}
		if (!isObject(data)) {
			warn(`data() should return an object.`);
		}
		else if (instance.data === EMPTY_OBJ) {
			instance.data = reactive(data);
		}
		else {
			extend(instance.data, data);
		}
	}
	// 创建watcher
	function createWatcher(raw, ctx, publicThis, key) {
		const getter = key.includes('.')
			? createPathGetter(publicThis, key)
			: () => publicThis[key];
		if (isString(raw)) {
			const handler = ctx[raw];
			if (isFunction(handler)) {
				watch(getter, handler);
			}
			else {
				warn(`Invalid watch handler specified by key "${raw}"`, handler);
			}
		}
		else if (isFunction(raw)) {
			watch(getter, raw.bind(publicThis));
		}
		else if (isObject(raw)) {
			if (isArray(raw)) {
				raw.forEach(r => createWatcher(r, ctx, publicThis, key));
			}
			else {
				const handler = isFunction(raw.handler)
					? raw.handler.bind(publicThis)
					: ctx[raw.handler];
				if (isFunction(handler)) {
					watch(getter, handler, raw);
				}
				else {
					warn(`Invalid watch handler specified by key "${raw.handler}"`, handler);
				}
			}
		}
		else {
			warn(`Invalid watch option: "${key}"`, raw);
		}
	}
	// 创建getter路径 e.g. obj = { info: { name: 'fanqiewa' } }  obj.info.name = 'fanqiewa'
	function createPathGetter(ctx, path) {
		const segments = path.split('.');
		return () => {
			let cur = ctx;
			for (let i = 0; i < segments.length && cur; i++) {
				cur = cur[segments[i]];
			}
			return cur;
		};
	}
	// 解析合并options
	function resolveMergedOptions(instance) {
		const raw = instance.type;
		const { __merged, mixins, extends: extendsOptions } = raw;
		if (__merged)
			return __merged;
		const globalMixins = instance.appContext.mixins;
		if (!globalMixins.length && !mixins && !extendsOptions)
			return raw;
		const options = {};
		globalMixins.forEach(m => mergeOptions(options, m, instance));
		mergeOptions(options, raw, instance);
		return (raw.__merged = options);
	}
	// 合并options
	function mergeOptions(to, from, instance) {
		// 合并策略
		const strats = instance.appContext.config.optionMergeStrategies;
		const { mixins, extends: extendsOptions } = from;
		extendsOptions && mergeOptions(to, extendsOptions, instance);
		mixins &&
			mixins.forEach((m) => mergeOptions(to, m, instance));
		for (const key in from) {
			if (strats && hasOwn(strats, key)) {
				to[key] = strats[key](to[key], from[key], instance.proxy, key);
			}
			else {
				to[key] = from[key];
			}
		}
	}

	const publicPropertiesMap = extend(Object.create(null), {
		$: i => i,
		$el: i => i.vnode.el,
		$data: i => i.data,
		$props: i => (shallowReadonly(i.props)),
		$attrs: i => (shallowReadonly(i.attrs)),
		$slots: i => (shallowReadonly(i.slots)),
		$refs: i => (shallowReadonly(i.refs)),
		$parent: i => i.parent && i.parent.proxy,
		$root: i => i.root && i.root.proxy,
		$emit: i => i.emit,
		$options: i => (resolveMergedOptions(i)),
		$forceUpdate: i => () => queueJob(i.update),
		$nextTick: i => nextTick.bind(i.proxy),
		$watch: i => (instanceWatch.bind(i))
	});
	const PublicInstanceProxyHandlers = {
		get({ _: instance }, key) {
			const { ctx, setupState, data, props, accessCache, type, appContext } = instance;
			if (key === "__v_skip" /* 跳过属性 */) {
				return true;
			}
			if (key === '__isVue') {
				return true;
			}
			let normalizedProps;
			if (key[0] !== '$') {
				const n = accessCache[key];
				if (n !== undefined) {
					switch (n) {
						case 0 /* SETUP */:
							return setupState[key];
						case 1 /* DATA */:
							return data[key];
						case 3 /* CONTEXT */:
							return ctx[key];
						case 2 /* PROPS */:
							return props[key];
					}
				}
				else if (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) {
					accessCache[key] = 0 /* SETUP */;
					return setupState[key];
				}
				else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
					accessCache[key] = 1 /* DATA */;
					return data[key];
				}
				else if (
					(normalizedProps = instance.propsOptions[0]) &&
					hasOwn(normalizedProps, key)) {
					accessCache[key] = 2 /* PROPS */;
					return props[key];
				}
				else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
					accessCache[key] = 3 /* CONTEXT */;
					return ctx[key];
				}
				else if (!isInBeforeCreate) {
					accessCache[key] = 4 /* OTHER */;
				}
			}
			const publicGetter = publicPropertiesMap[key];
			let cssModule, globalProperties;
			if (publicGetter) {
				if (key === '$attrs') {
					track(instance, "get" /* GET */, key);
					markAttrsAccessed();
				}
				return publicGetter(instance);
			}
			else if (
				(cssModule = type.__cssModules) &&
				(cssModule = cssModule[key])) {
				return cssModule;
			}
			else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
				accessCache[key] = 3 /* CONTEXT */;
				return ctx[key];
			}
			else if (
				((globalProperties = appContext.config.globalProperties),
					hasOwn(globalProperties, key))) {
				return globalProperties[key];
			}
			else if (
				currentRenderingInstance &&
				(!isString(key) ||
					key.indexOf('__v') !== 0)) {
				if (data !== EMPTY_OBJ &&
					(key[0] === '$' || key[0] === '_') &&
					hasOwn(data, key)) {
					warn(`Property ${JSON.stringify(key)} must be accessed via $data because it starts with a reserved ` +
						`character ("$" or "_") and is not proxied on the render context.`);
				}
				else {
					warn(`Property ${JSON.stringify(key)} was accessed during render ` +
						`but is not defined on instance.`);
				}
			}
		},
		set({ _: instance }, key, value) {
			const { data, setupState, ctx } = instance;
			if (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) {
				setupState[key] = value;
			}
			else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
				data[key] = value;
			}
			else if (key in instance.props) {

				warn(`Attempting to mutate prop "${key}". Props are readonly.`, instance);
				return false;
			}
			if (key[0] === '$' && key.slice(1) in instance) {

				warn(`Attempting to mutate public property "${key}". ` +
					`Properties starting with $ are reserved and readonly.`, instance);
				return false;
			}
			else {
				if (key in instance.appContext.config.globalProperties) {
					Object.defineProperty(ctx, key, {
						enumerable: true,
						configurable: true,
						value
					});
				}
				else {
					ctx[key] = value;
				}
			}
			return true;
		},
		has({ _: { data, setupState, accessCache, ctx, appContext, propsOptions } }, key) {
			let normalizedProps;
			return (accessCache[key] !== undefined ||
				(data !== EMPTY_OBJ && hasOwn(data, key)) ||
				(setupState !== EMPTY_OBJ && hasOwn(setupState, key)) ||
				((normalizedProps = propsOptions[0]) && hasOwn(normalizedProps, key)) ||
				hasOwn(ctx, key) ||
				hasOwn(publicPropertiesMap, key) ||
				hasOwn(appContext.config.globalProperties, key));
		}
	};
	{
		PublicInstanceProxyHandlers.ownKeys = (target) => {
			warn(`Avoid app logic that relies on enumerating keys on a component instance. ` +
				`The keys will be empty in production mode to avoid performance overhead.`);
			return Reflect.ownKeys(target);
		};
	}
	const RuntimeCompiledPublicInstanceProxyHandlers = extend({}, PublicInstanceProxyHandlers, {
		get(target, key) {
			if (key === Symbol.unscopables) {
				return;
			}
			return PublicInstanceProxyHandlers.get(target, key, target);
		},
		has(_, key) {
			const has = key[0] !== '_' && !isGloballyWhitelisted(key);
			if (!has && PublicInstanceProxyHandlers.has(_, key)) {
				warn(`Property ${JSON.stringify(key)} should not start with _ which is a reserved prefix for Vue internals.`);
			}
			return has;
		}
	});
	// 创建render上下文
	function createRenderContext(instance) {
		const target = {};
		Object.defineProperty(target, `_`, {
			configurable: true,
			enumerable: false,
			get: () => instance
		});
		Object.keys(publicPropertiesMap).forEach(key => {
			Object.defineProperty(target, key, {
				configurable: true,
				enumerable: false,
				get: () => publicPropertiesMap[key](instance),
				set: NOOP
			});
		});
		// 暴露全局属性
		const { globalProperties } = instance.appContext.config;
		Object.keys(globalProperties).forEach(key => {
			Object.defineProperty(target, key, {
				configurable: true,
				enumerable: false,
				get: () => globalProperties[key],
				set: NOOP
			});
		});
		return target;
	}
	// 暴露props属性到context上下文中
	// 通过vm.[props]取值时，取的是instance.props[key]
	function exposePropsOnRenderContext(instance) {
		const { ctx, propsOptions: [propsOptions] } = instance;
		if (propsOptions) {
			Object.keys(propsOptions).forEach(key => {
				Object.defineProperty(ctx, key, {
					enumerable: true,
					configurable: true,
					get: () => instance.props[key],
					set: NOOP
				});
			});
		}
	}
	// 暴露setupState属性到context上下文中
	// 通过vm.[setupState]取值时，取的是instance.setupState[key]
	function exposeSetupStateOnRenderContext(instance) {
		const { ctx, setupState } = instance;
		Object.keys(toRaw(setupState)).forEach(key => {
			if (key[0] === '$' || key[0] === '_') {
				// setup返回的对象属性中不能以`$`或`_`开头
				warn(`setup() return property ${JSON.stringify(key)} should not start with "$" or "_" ` +
					`which are reserved prefixes for Vue internals.`);
				return;
			}
			Object.defineProperty(ctx, key, {
				enumerable: true,
				configurable: true,
				get: () => setupState[key],
				set: NOOP
			});
		});
	}

	// 空的上下文对象
	const emptyAppContext = createAppContext();
	let uid$2 = 0;
	// 创建组件实例
	function createComponentInstance(vnode, parent, suspense) {
		const type = vnode.type;
		const appContext = (parent ? parent.appContext : vnode.appContext) || emptyAppContext;
		const instance = {
			uid: uid$2++,
			vnode,
			type,
			parent,
			appContext,
			root: null,
			next: null,
			subTree: null,
			update: null,
			render: null,
			proxy: null,
			withProxy: null,
			effects: null,
			provides: parent ? parent.provides : Object.create(appContext.provides),
			accessCache: null,
			renderCache: [],
			components: null,
			directives: null,
			propsOptions: normalizePropsOptions(type, appContext),
			emitsOptions: normalizeEmitsOptions(type, appContext),
			emit: null,
			emitted: null,
			ctx: EMPTY_OBJ,
			data: EMPTY_OBJ,
			props: EMPTY_OBJ,
			attrs: EMPTY_OBJ,
			slots: EMPTY_OBJ,
			refs: EMPTY_OBJ,
			setupState: EMPTY_OBJ,
			setupContext: null,
			suspense,
			suspenseId: suspense ? suspense.pendingId : 0,
			asyncDep: null,
			asyncResolved: false,
			isMounted: false,
			isUnmounted: false,
			isDeactivated: false,
			bc: null,
			c: null,
			bm: null,
			m: null,
			bu: null,
			u: null,
			um: null,
			bum: null,
			da: null,
			a: null,
			rtg: null,
			rtc: null,
			ec: null
		};
		{
			instance.ctx = createRenderContext(instance);
		}
		instance.root = parent ? parent.root : instance;
		instance.emit = emit.bind(null, instance);
		{
			devtoolsComponentAdded(instance);
		}
		return instance;
	}
	let currentInstance = null;
	const getCurrentInstance = () => currentInstance || currentRenderingInstance;
	const setCurrentInstance = (instance) => {
		currentInstance = instance;
	};

	// 验证组件名称，不能使用slot、component和HTML自带的标签
	const isBuiltInTag = /*#__PURE__*/ makeMap('slot,component');
	function validateComponentName(name, config) {
		const appIsNativeTag = config.isNativeTag || NO;
		if (isBuiltInTag(name) || appIsNativeTag(name)) {
			warn('Do not use built-in or reserved HTML elements as component id: ' + name);
		}
	}

	// 安装组件
	let isInSSRComponentSetup = false;
	function setupComponent(instance, isSSR = false) {
		isInSSRComponentSetup = isSSR;
		const { props, children, shapeFlag } = instance.vnode;
		const isStateful = shapeFlag & 4 /* STATEFUL_COMPONENT */;
		// 初始化props
		initProps(instance, props, isStateful, isSSR);
		// 初始化slots
		initSlots(instance, children);
		const setupResult = isStateful
			? setupStatefulComponent(instance, isSSR)
			: undefined;
		isInSSRComponentSetup = false;
		return setupResult;
	}
	// 安装有状态的组件
	function setupStatefulComponent(instance, isSSR) {
		const Component = instance.type;
		{
			if (Component.name) {
				// 校验组件名称
				validateComponentName(Component.name, instance.appContext.config);
			}
			if (Component.components) {
				// 子组件
				const names = Object.keys(Component.components);
				for (let i = 0; i < names.length; i++) {
					validateComponentName(names[i], instance.appContext.config);
				}
			}
			if (Component.directives) {
				const names = Object.keys(Component.directives);
				for (let i = 0; i < names.length; i++) {
					// 校验指令名称
					validateDirectiveName(names[i]);
				}
			}
		}
		instance.accessCache = Object.create(null);
		instance.proxy = new Proxy(instance.ctx, PublicInstanceProxyHandlers);
		{
			// 暴露props
			exposePropsOnRenderContext(instance);
		}
		// 如果组件提供了setup
		const { setup } = Component;
		if (setup) {
			const setupContext = (instance.setupContext =
				setup.length > 1 ? createSetupContext(instance) : null);
			currentInstance = instance;
			pauseTracking();
			const setupResult = callWithErrorHandling(setup, instance, 0 /* SETUP_FUNCTION */, [shallowReadonly(instance.props), setupContext]);
			resetTracking();
			currentInstance = null;
			if (isPromise(setupResult)) {
				if (isSSR) {
					return setupResult.then((resolvedResult) => {
						handleSetupResult(instance, resolvedResult);
					});
				}
				else {
					instance.asyncDep = setupResult;
				}
			}
			else {
				handleSetupResult(instance, setupResult);
			}
		}
		else {
			finishComponentSetup(instance);
		}
	}
	// 处理setup返回结果
	function handleSetupResult(instance, setupResult, isSSR) {
		if (isFunction(setupResult)) {
			// 如果返回的是一个函数，则将其赋值给实例的render函数
			instance.render = setupResult;
		}
		else if (isObject(setupResult)) {
			if (isVNode(setupResult)) {
				warn(`setup() should not return VNodes directly - ` +
					`return a render function instead.`);
			}
			{
				instance.devtoolsRawSetupState = setupResult;
			}
			// 返回对象，则将其赋值到setupState属性
			instance.setupState = proxyRefs(setupResult);
			{
				exposeSetupStateOnRenderContext(instance);
			}
		}
		else if (setupResult !== undefined) {
			warn(`setup() should return an object. Received: ${setupResult === null ? 'null' : typeof setupResult}`);
		}
		finishComponentSetup(instance);
	}
	let compile;
	// 注册运行期的compile
	function registerRuntimeCompiler(_compile) {
		compile = _compile;
	}
	// 完成组件的安装
	function finishComponentSetup(instance, isSSR) {
		const Component = instance.type;
		if (!instance.render) {
			// 有template
			if (compile && Component.template && !Component.render) {
				{
					startMeasure(instance, `compile`);
				}
				Component.render = compile(Component.template, {
					isCustomElement: instance.appContext.config.isCustomElement,
					delimiters: Component.delimiters
				});
				{
					endMeasure(instance, `compile`);
				}
			}
			instance.render = (Component.render || NOOP);
			if (instance.render._rc) {
				instance.withProxy = new Proxy(instance.ctx, RuntimeCompiledPublicInstanceProxyHandlers);
			}
		}
		{
			// 兼容vue2的生命周期配置
			currentInstance = instance;
			applyOptions(instance, Component);
			currentInstance = null;
		}
		// 缺少 template/render
		if (!Component.render && instance.render === NOOP) {
			if (!compile && Component.template) {
				warn(`Component provided template option but ` +
					`runtime compilation is not supported in this build of Vue.` +
					(` Use "vue.global.js" instead.`
					) /* should not happen */);
			}
			else {
				warn(`Component is missing template or render function.`);
			}
		}
	}
	// attr的拦截对象
	const attrHandlers = {
		get: (target, key) => {
			{
				markAttrsAccessed();
			}
			return target[key];
		},
		set: () => {
			warn(`setupContext.attrs is readonly.`);
			return false;
		},
		deleteProperty: () => {
			warn(`setupContext.attrs is readonly.`);
			return false;
		}
	};
	// 创建setup上下文
	function createSetupContext(instance) {
		{
			return Object.freeze({
				get attrs() {
					return new Proxy(instance.attrs, attrHandlers);
				},
				get slots() {
					return shallowReadonly(instance.slots);
				},
				get emit() {
					return (event, ...args) => instance.emit(event, ...args);
				}
			});
		}
	}
	// 记录实例绑定effect
	function recordInstanceBoundEffect(effect) {
		if (currentInstance) {
			(currentInstance.effects || (currentInstance.effects = [])).push(effect);
		}
	}

	// 将中划线和下划线命名转成驼峰命名
	// e.g. -webkit_transition => WebkitTransition
	const classifyRE = /(?:^|[-_])(\w)/g;
	const classify = (str) => str.replace(classifyRE, c => c.toUpperCase()).replace(/[-_]/g, '');
	
	// 格式化组件名称
	function formatComponentName(instance, Component, isRoot = false) {
		let name /* 组件名称 */ = isFunction(Component)
			? Component.displayName || Component.name
			: Component.name;

		// createApp的options中传递了__file
		if (!name && Component.__file) {
			const match = Component.__file.match(/([^/\\]+)\.vue$/);
			if (match) {
				name = match[1];
			}
		}
		if (!name && instance && instance.parent) {
			// 尝试根据已经注册的组件推测出组件名称
			// e.g. registry /* 注册过的 */ => components: { Child }
			const inferFromRegistry = (registry) => {
				for (const key in registry) {
					// 遍历已注册的组件，如果存在相等的组件，则返回相等的属性名
					if (registry[key] === Component) {
						return key;
					}
				}
			};
			name =
				// 尝试从实例的options的components属性中推测 TODO 关于instance.components和instance.appContext的区别
				inferFromRegistry(instance.components ||
				// 尝试从实例的appContext的components属性中推测
					instance.parent.type.components) || inferFromRegistry(instance.appContext.components);
		}
		return name ? classify(name) : isRoot ? `App` : `Anonymous`;
	}
	// 判断组件是否为类组件
	function isClassComponent(value) {
		return isFunction(value) && '__vccOpts' in value;
	}

	// 构造computed计算属性
	function computed$1(getterOrOptions) {
		const c = computed(getterOrOptions);
		recordInstanceBoundEffect(c.effect);
		return c;
	}
	// 定义组件
	function defineComponent(options) {
		return isFunction(options) ? { setup: options, name: options.name } : options;
	}

	// 定义异步加载组件
	function defineAsyncComponent(source) {
		if (isFunction(source)) {
			source = { loader: source };
		}
		const { loader, loadingComponent: loadingComponent, errorComponent: errorComponent, delay = 200, timeout, // undefined = never times out
			suspensible = true, onError: userOnError } = source;
		let pendingRequest = null;
		let resolvedComp;
		let retries = 0;
		const retry = () => {
			retries++;
			pendingRequest = null;
			return load();
		};
		const load = () => {
			let thisRequest;
			return (pendingRequest ||
				(thisRequest = pendingRequest = loader()
					.catch(err => {
						err = err instanceof Error ? err : new Error(String(err));
						if (userOnError) {
							return new Promise((resolve, reject) => {
								const userRetry = () => resolve(retry());
								const userFail = () => reject(err);
								userOnError(err, userRetry, userFail, retries + 1);
							});
						}
						else {
							throw err;
						}
					})
					.then((comp) => {
						if (thisRequest !== pendingRequest && pendingRequest) {
							return pendingRequest;
						}
						if (!comp) {
							warn(`Async component loader resolved to undefined. ` +
								`If you are using retry(), make sure to return its return value.`);
						}
						if (comp &&
							(comp.__esModule || comp[Symbol.toStringTag] === 'Module')) {
							comp = comp.default;
						}
						if (comp && !isObject(comp) && !isFunction(comp)) {
							throw new Error(`Invalid async component load result: ${comp}`);
						}
						resolvedComp = comp;
						return comp;
					})));
		};
		return defineComponent({
			__asyncLoader: load,
			name: 'AsyncComponentWrapper',
			setup() {
				const instance = currentInstance;
				// 已经解析过了
				if (resolvedComp) {
					return () => createInnerComp(resolvedComp, instance);
				}
				const onError = (err) => {
					pendingRequest = null;
					handleError(err, instance, 13 /* ASYNC_COMPONENT_LOADER */, !errorComponent /* do not throw in dev if user provided error component */);
				};
				if ((suspensible && instance.suspense) ||
					(false)) {
					return load()
						.then(comp => {
							return () => createInnerComp(comp, instance);
						})
						.catch(err => {
							onError(err);
							return () => errorComponent
								? createVNode(errorComponent, {
									error: err
								})
								: null;
						});
				}
				const loaded = ref(false);
				const error = ref();
				const delayed = ref(!!delay);
				if (delay) {
					setTimeout(() => {
						delayed.value = false;
					}, delay);
				}
				if (timeout != null) {
					setTimeout(() => {
						if (!loaded.value && !error.value) {
							const err = new Error(`Async component timed out after ${timeout}ms.`);
							onError(err);
							error.value = err;
						}
					}, timeout);
				}
				load()
					.then(() => {
						loaded.value = true;
					})
					.catch(err => {
						onError(err);
						error.value = err;
					});
				return () => {
					if (loaded.value && resolvedComp) {
						return createInnerComp(resolvedComp, instance);
					}
					else if (error.value && errorComponent) {
						return createVNode(errorComponent, {
							error: error.value
						});
					}
					else if (loadingComponent && !delayed.value) {
						return createVNode(loadingComponent);
					}
				};
			}
		});
	}
	function createInnerComp(comp, { vnode: { props, children } }) {
		return createVNode(comp, props, children);
	}

	// 渲染函数
	function h(type, propsOrChildren, children) {
		const l = arguments.length;
		if (l === 2) {
			if (isObject(propsOrChildren) && !isArray(propsOrChildren)) {
				// 有单个子元素，但是没有props
				if (isVNode(propsOrChildren)) {
					return createVNode(type, null, [propsOrChildren]);
				}
				// 有props，但是没有子元素
				return createVNode(type, propsOrChildren);
			}
			else {
				// 参数长度大于3，则从第三个开始（包含3），后面的参数都作为子元素
				return createVNode(type, null, propsOrChildren);
			}
		}
		else {
			if (l > 3) {
				children = Array.prototype.slice.call(arguments, 2);
			}
			else if (l === 3 && isVNode(children)) {
				children = [children];
			}
			return createVNode(type, propsOrChildren, children);
		}
	}

	const ssrContextKey = Symbol(`ssrContext`);
	const useSSRContext = () => {
		{
			warn(`useSsrContext() is not supported in the global build.`);
		}
	};

	// 初始化自定义格式绑定 TODO
	function initCustomFormatter() {
		const vueStyle = { style: 'color:#3ba776' };
		const numberStyle = { style: 'color:#0b1bc9' };
		const stringStyle = { style: 'color:#b62e24' };
		const keywordStyle = { style: 'color:#9d288c' };
		// 自定义格式化Chrome
		// https://www.mattzeunert.com/2016/02/19/custom-chrome-devtools-object-formatters.html
		const formatter = {
			header(obj) {
				// TODO also format ComponentPublicInstance & ctx.slots/attrs in setup
				if (!isObject(obj)) {
					return null;
				}
				if (obj.__isVue) {
					return ['div', vueStyle, `VueInstance`];
				}
				else if (isRef(obj)) {
					return [
						'div',
						{},
						['span', vueStyle, genRefFlag(obj)],
						'<',
						formatValue(obj.value),
						`>`
					];
				}
				else if (isReactive(obj)) {
					return [
						'div',
						{},
						['span', vueStyle, 'Reactive'],
						'<',
						formatValue(obj),
						`>${isReadonly(obj) ? ` (readonly)` : ``}`
					];
				}
				else if (isReadonly(obj)) {
					return [
						'div',
						{},
						['span', vueStyle, 'Readonly'],
						'<',
						formatValue(obj),
						'>'
					];
				}
				return null;
			},
			hasBody(obj) {
				return obj && obj.__isVue;
			},
			body(obj) {
				if (obj && obj.__isVue) {
					return [
						'div',
						{},
						...formatInstance(obj.$)
					];
				}
			}
		};
		function formatInstance(instance) {
			const blocks = [];
			if (instance.type.props && instance.props) {
				blocks.push(createInstanceBlock('props', toRaw(instance.props)));
			}
			if (instance.setupState !== EMPTY_OBJ) {
				blocks.push(createInstanceBlock('setup', instance.setupState));
			}
			if (instance.data !== EMPTY_OBJ) {
				blocks.push(createInstanceBlock('data', toRaw(instance.data)));
			}
			const computed = extractKeys(instance, 'computed');
			if (computed) {
				blocks.push(createInstanceBlock('computed', computed));
			}
			const injected = extractKeys(instance, 'inject');
			if (injected) {
				blocks.push(createInstanceBlock('injected', injected));
			}
			blocks.push([
				'div',
				{},
				[
					'span',
					{
						style: keywordStyle.style + ';opacity:0.66'
					},
					'$ (internal): '
				],
				['object', { object: instance }]
			]);
			return blocks;
		}
		function createInstanceBlock(type, target) {
			target = extend({}, target);
			if (!Object.keys(target).length) {
				return ['span', {}];
			}
			return [
				'div',
				{ style: 'line-height:1.25em;margin-bottom:0.6em' },
				[
					'div',
					{
						style: 'color:#476582'
					},
					type
				],
				[
					'div',
					{
						style: 'padding-left:1.25em'
					},
					...Object.keys(target).map(key => {
						return [
							'div',
							{},
							['span', keywordStyle, key + ': '],
							formatValue(target[key], false)
						];
					})
				]
			];
		}
		function formatValue(v, asRaw = true) {
			if (typeof v === 'number') {
				return ['span', numberStyle, v];
			}
			else if (typeof v === 'string') {
				return ['span', stringStyle, JSON.stringify(v)];
			}
			else if (typeof v === 'boolean') {
				return ['span', keywordStyle, v];
			}
			else if (isObject(v)) {
				return ['object', { object: asRaw ? toRaw(v) : v }];
			}
			else {
				return ['span', stringStyle, String(v)];
			}
		}
		function extractKeys(instance, type) {
			const Comp = instance.type;
			if (isFunction(Comp)) {
				return;
			}
			const extracted = {};
			for (const key in instance.ctx) {
				if (isKeyOfType(Comp, key, type)) {
					extracted[key] = instance.ctx[key];
				}
			}
			return extracted;
		}
		function isKeyOfType(Comp, key, type) {
			const opts = Comp[type];
			if ((isArray(opts) && opts.includes(key)) ||
				(isObject(opts) && key in opts)) {
				return true;
			}
			if (Comp.extends && isKeyOfType(Comp.extends, key, type)) {
				return true;
			}
			if (Comp.mixins && Comp.mixins.some(m => isKeyOfType(m, key, type))) {
				return true;
			}
		}
		function genRefFlag(v) {
			if (v._shallow) {
				return `ShallowRef`;
			}
			if (v.effect) {
				return `ComputedRef`;
			}
			return `Ref`;
		}
		/* eslint-disable no-restricted-globals */
		if (window.devtoolsFormatters) {
			window.devtoolsFormatters.push(formatter);
		}
		else {
			window.devtoolsFormatters = [formatter];
		}
	}
	// 渲染列表
	function renderList(source, renderItem) {
		let ret;
		if (isArray(source) || isString(source)) {
			ret = new Array(source.length);
			for (let i = 0, l = source.length; i < l; i++) {
				ret[i] = renderItem(source[i], i);
			}
		}
		else if (typeof source === 'number') {
			if (!Number.isInteger(source)) {
				warn(`The v-for range expect an integer value but got ${source}.`);
				return [];
			}
			ret = new Array(source);
			for (let i = 0; i < source; i++) {
				ret[i] = renderItem(i + 1, i);
			}
		}
		else if (isObject(source)) {
			if (source[Symbol.iterator]) {
				ret = Array.from(source, renderItem);
			}
			else {
				const keys = Object.keys(source);
				ret = new Array(keys.length);
				for (let i = 0, l = keys.length; i < l; i++) {
					const key = keys[i];
					ret[i] = renderItem(source[key], key, i);
				}
			}
		}
		else {
			ret = [];
		}
		return ret;
	}
	// v-on期待一个对象类型的value
	function toHandlers(obj) {
		const ret = {};
		if (!isObject(obj)) {
			warn(`v-on with no argument expects an object value.`);
			return ret;
		}
		for (const key in obj) {
			ret[toHandlerKey(key)] = obj[key];
		}
		return ret;
	}
	// 创建插槽
	function createSlots(slots, dynamicSlots) {
		for (let i = 0; i < dynamicSlots.length; i++) {
			const slot = dynamicSlots[i];
			if (isArray(slot)) {
				for (let j = 0; j < slot.length; j++) {
					slots[slot[j].name] = slot[j].fn;
				}
			}
			else if (slot) {
				slots[slot.name] = slot.fn;
			}
		}
		return slots;
	}

	// Core API ------------------------------------------------------------------
	const version = "3.0.2";
	const ssrUtils = (null);

	const svgNS = 'http://www.w3.org/2000/svg';
	const doc = (typeof document !== 'undefined' ? document : null);
	let tempContainer;
	let tempSVGContainer;
	const nodeOps = {
		// 插入元素
		insert: (child, parent, anchor) => {
			parent.insertBefore(child, anchor || null);
		},
		// 移除元素
		remove: child => {
			const parent = child.parentNode;
			if (parent) {
				parent.removeChild(child);
			}
		},
		// 创建元素
		createElement: (tag, isSVG, is) => isSVG
			? doc.createElementNS(svgNS, tag)
			: doc.createElement(tag, is ? { is } : undefined),
		// 创建元素
		createText: text => doc.createTextNode(text),
		// 创建注释节点
		createComment: text => doc.createComment(text),
		// 设置文本
		setText: (node, text) => {
			node.nodeValue = text;
		},
		// 设置元素文本
		setElementText: (el, text) => {
			el.textContent = text;
		},
		// 获取父节点
		parentNode: node => node.parentNode,
		// 获取兄弟节点
		nextSibling: node => node.nextSibling,
		// 查询元素
		querySelector: selector => doc.querySelector(selector),
		// 设置作用域id
		setScopeId(el, id) {
			el.setAttribute(id, '');
		},
		// 克隆元素
		cloneNode(el) {
			return el.cloneNode(true);
		},
		// 插入静态内容
		insertStaticContent(content, parent, anchor, isSVG) {
			const temp = isSVG
				? tempSVGContainer ||
				(tempSVGContainer = doc.createElementNS(svgNS, 'svg'))
				: tempContainer || (tempContainer = doc.createElement('div'));
			temp.innerHTML = content;
			const first = temp.firstChild;
			let node = first;
			let last = node;
			while (node) {
				last = node;
				nodeOps.insert(node, parent, anchor);
				node = temp.firstChild;
			}
			return [first, last];
		}
	};

	// 修补class
	function patchClass(el, value, isSVG) {
		if (value == null) {
			value = '';
		}
		if (isSVG) {
			el.setAttribute('class', value);
		}
		else {
			const transitionClasses = el._vtc;
			if (transitionClasses) {
				value = (value
					? [value, ...transitionClasses]
					: [...transitionClasses]).join(' ');
			}
			el.className = value;
		}
	}
	// 修补style
	function patchStyle(el, prev, next) {
		const style = el.style;
		if (!next) {
			el.removeAttribute('style');
		}
		else if (isString(next)) {
			if (prev !== next) {
				style.cssText = next;
			}
		}
		else {
			for (const key in next) {
				setStyle(style, key, next[key]);
			}
			if (prev && !isString(prev)) {
				for (const key in prev) {
					if (next[key] == null) {
						// 去掉dom更新前的style
						setStyle(style, key, '');
					}
				}
			}
		}
	}
	const importantRE = /\s*!important$/;
	// 设置style属性
	function setStyle(style, name, val) {
		if (isArray(val)) {
			val.forEach(v => setStyle(style, name, v));
		}
		else {
			if (name.startsWith('--')) {
				// 自定义样式
				style.setProperty(name, val);
			}
			else {
				const prefixed = autoPrefix(style, name);
				if (importantRE.test(val)) {
					// !important
					style.setProperty(hyphenate(prefixed), val.replace(importantRE, ''), 'important');
				}
				else {
					style[prefixed] = val;
				}
			}
		}
	}
	const prefixes = ['Webkit', 'Moz', 'ms'];
	const prefixCache = {};
	// 添加默认前缀
	function autoPrefix(style, rawName) {
		const cached = prefixCache[rawName];
		if (cached) {
			return cached;
		}
		let name = camelize(rawName);
		if (name !== 'filter' && name in style) {
			return (prefixCache[rawName] = name);
		}
		name = capitalize(name);
		for (let i = 0; i < prefixes.length; i++) {
			const prefixed = prefixes[i] + name;
			if (prefixed in style) {
				return (prefixCache[rawName] = prefixed);
			}
		}
		return rawName;
	}

	const xlinkNS = 'http://www.w3.org/1999/xlink';
	// 给attr打补丁
	function patchAttr(el, key, value, isSVG) {
		if (isSVG && key.startsWith('xlink:')) {
			if (value == null) {
				el.removeAttributeNS(xlinkNS, key.slice(6, key.length));
			}
			else {
				el.setAttributeNS(xlinkNS, key, value);
			}
		}
		else {
			const isBoolean = isSpecialBooleanAttr(key);
			if (value == null || (isBoolean && value === false)) {
				el.removeAttribute(key);
			}
			else {
				el.setAttribute(key, isBoolean ? '' : value);
			}
		}
	}
	// 修补dom的prop
	function patchDOMProp(el, key, value,
		prevChildren, parentComponent, parentSuspense, unmountChildren) {
		if (key === 'innerHTML' || key === 'textContent') {
			if (prevChildren) {
				// 移除当前元素的所有子元素
				unmountChildren(prevChildren, parentComponent, parentSuspense);
			}
			el[key] = value == null ? '' : value;
			return;
		}
		if (key === 'value' && el.tagName !== 'PROGRESS') {
			el._value = value;
			const newValue = value == null ? '' : value;
			if (el.value !== newValue) {
				el.value = newValue;
			}
			return;
		}
		if (value === '' && typeof el[key] === 'boolean') {
			// e.g. <select multiple> compiles to { multiple: '' }
			el[key] = true;
		}
		else if (value == null && typeof el[key] === 'string') {
			// e.g. <div :id="null">
			el[key] = '';
			el.removeAttribute(key);
		}
		else {
			// 一些元素需要使用校验
			try {
				el[key] = value;
			}
			catch (e) {
				{
					warn(`Failed setting prop "${key}" on <${el.tagName.toLowerCase()}>: ` +
						`value ${value} is invalid.`, e);
				}
			}
		}
	}

	let _getNow = Date.now;
	if (typeof document !== 'undefined' &&
		_getNow() > document.createEvent('Event').timeStamp) {
		_getNow = () => performance.now();
	}
	let cachedNow = 0;
	const p = Promise.resolve();
	const reset = () => {
		cachedNow = 0;
	};
	const getNow = () => cachedNow || (p.then(reset), (cachedNow = _getNow()));
	function addEventListener(el, event, handler, options) {
		el.addEventListener(event, handler, options);
	}
	function removeEventListener(el, event, handler, options) {
		el.removeEventListener(event, handler, options);
	}
	// 给事件打补丁
	function patchEvent(el, rawName, prevValue, nextValue, instance = null) {
		const invokers = el._vei || (el._vei = {});
		const existingInvoker = invokers[rawName];
		if (nextValue && existingInvoker) {
			// patch
			existingInvoker.value = nextValue;
		}
		else {
			const [name, options] = parseName(rawName);
			if (nextValue) {
				// add
				const invoker = (invokers[rawName] = createInvoker(nextValue, instance));
				addEventListener(el, name, invoker, options);
			}
			else if (existingInvoker) {
				// remove
				removeEventListener(el, name, existingInvoker, options);
				invokers[rawName] = undefined;
			}
		}
	}
	// 匹配修饰词 Once|Passive|Capture
	const optionsModifierRE = /(?:Once|Passive|Capture)$/;
	// 处理名称
	function parseName(name) {
		let options;
		if (optionsModifierRE.test(name)) {
			options = {};
			let m;
			while ((m = name.match(optionsModifierRE))) {
				name = name.slice(0, name.length - m[0].length); // 裁剪掉修饰词
				options[m[0].toLowerCase()] = true;
			}
		}
		return [name.slice(2).toLowerCase(), options];
	}
	// 创建invoker（命令）
	function createInvoker(initialValue, instance) {
		const invoker = (e) => {
			const timeStamp = e.timeStamp || _getNow();
			if (timeStamp >= invoker.attached - 1) {
				callWithAsyncErrorHandling(patchStopImmediatePropagation(e, invoker.value), instance, 5 /* NATIVE_EVENT_HANDLER */, [e]);
			}
		};
		invoker.value = initialValue;
		invoker.attached = getNow();
		return invoker;
	}
	// 阻止事件的传播（当value为数组时）
	function patchStopImmediatePropagation(e, value) {
		if (isArray(value)) {
			const originalStop = e.stopImmediatePropagation;
			e.stopImmediatePropagation = () => {
				originalStop.call(e);
				e._stopped = true;
			};
			return value.map(fn => (e) => !e._stopped && fn(e));
		}
		else {
			return value;
		}
	}

	const nativeOnRE = /^on[a-z]/;
	// 强制更新prop
	const forcePatchProp = (_, key) => key === 'value';
	// 给prop打补丁
	const patchProp = (el, key, prevValue, nextValue, isSVG = false, prevChildren, parentComponent, parentSuspense, unmountChildren) => {
		switch (key) {
			// class
			case 'class':
				patchClass(el, nextValue, isSVG);
				break;
			// style
			case 'style':
				patchStyle(el, prevValue, nextValue);
				break;
			default:
				// on
				if (isOn(key)) {
					// 忽略v-model绑定的key
					if (!isModelListener(key)) {
						patchEvent(el, key, prevValue, nextValue, parentComponent);
					}
				}
				else if (shouldSetAsProp(el, key, nextValue, isSVG)) {
					// 普通的dom绑定的属性
					patchDOMProp(el, key, nextValue, prevChildren, parentComponent, parentSuspense, unmountChildren);
				}
				else {
					if (key === 'true-value') {
						el._trueValue = nextValue;
					}
					else if (key === 'false-value') {
						el._falseValue = nextValue;
					}
					patchAttr(el, key, nextValue, isSVG);
				}
				break;
		}
	};
	// 判断key值是否能被设置成prop
	function shouldSetAsProp(el, key, value, isSVG) {
		if (isSVG) {
			if (key === 'innerHTML') {
				return true;
			}
			if (key in el && nativeOnRE.test(key) && isFunction(value)) {
				return true;
			}
			return false;
		}
		if (key === 'spellcheck' || key === 'draggable') {
			return false;
		}
		if (key === 'form' && typeof value === 'string') {
			return false;
		}
		if (key === 'list' && el.tagName === 'INPUT') {
			return false;
		}
		if (nativeOnRE.test(key) && isString(value)) {
			return false;
		}
		return key in el;
	}

	function useCssModule(name = '$style') {
		{
			{
				warn(`useCssModule() is not supported in the global build.`);
			}
			return EMPTY_OBJ;
		}
	}

	function useCssVars(getter, scoped = false) {
		const instance = getCurrentInstance();
		if (!instance) {

			warn(`useCssVars is called without current active component instance.`);
			return;
		}
		const prefix = scoped && instance.type.__scopeId
			? `${instance.type.__scopeId.replace(/^data-v-/, '')}-`
			: ``;
		const setVars = () => setVarsOnVNode(instance.subTree, getter(instance.proxy), prefix);
		onMounted(() => watchEffect(setVars));
		onUpdated(setVars);
	}
	function setVarsOnVNode(vnode, vars, prefix) {
		if (vnode.shapeFlag & 128 /* SUSPENSE */) {
			const suspense = vnode.suspense;
			vnode = suspense.activeBranch;
			if (suspense.pendingBranch && !suspense.isHydrating) {
				suspense.effects.push(() => {
					setVarsOnVNode(suspense.activeBranch, vars, prefix);
				});
			}
		}
		while (vnode.component) {
			vnode = vnode.component.subTree;
		}
		if (vnode.shapeFlag & 1 /* ELEMENT */ && vnode.el) {
			const style = vnode.el.style;
			for (const key in vars) {
				style.setProperty(`--${prefix}${key}`, unref(vars[key]));
			}
		}
		else if (vnode.type === Fragment) {
			vnode.children.forEach(c => setVarsOnVNode(c, vars, prefix));
		}
	}

	const TRANSITION = 'transition';
	const ANIMATION = 'animation';
	// Transition组件
	const Transition = (props, { slots }) => h(BaseTransition, resolveTransitionProps(props), slots);
	Transition.displayName = 'Transition';
	const DOMTransitionPropsValidators = {
		name: String,
		type: String,
		css: {
			type: Boolean,
			default: true
		},
		duration: [String, Number, Object],
		enterFromClass: String,
		enterActiveClass: String,
		enterToClass: String,
		appearFromClass: String,
		appearActiveClass: String,
		appearToClass: String,
		leaveFromClass: String,
		leaveActiveClass: String,
		leaveToClass: String
	};
	const TransitionPropsValidators = (Transition.props = /*#__PURE__*/ extend({}, BaseTransition.props, DOMTransitionPropsValidators));
	// 解析Transition组件的props
	// rawProps为原始vue自带的props，默认值有 `appear`, `css`, `persisted`
	function resolveTransitionProps(rawProps) {
		let { name = 'v', type, css = true, duration, enterFromClass = `${name}-enter-from`, enterActiveClass = `${name}-enter-active`, enterToClass = `${name}-enter-to`, appearFromClass = enterFromClass, appearActiveClass = enterActiveClass, appearToClass = enterToClass, leaveFromClass = `${name}-leave-from`, leaveActiveClass = `${name}-leave-active`, leaveToClass = `${name}-leave-to` } = rawProps;
		// BaseTransition的props
		const baseProps = {};
		for (const key in rawProps) {
			if (!(key in DOMTransitionPropsValidators)) {
				baseProps[key] = rawProps[key];
			}
		}
		if (!css) {
			return baseProps;
		}
		const durations = normalizeDuration(duration);
		const enterDuration = durations && durations[0];
		const leaveDuration = durations && durations[1];
		const { onBeforeEnter, onEnter, onEnterCancelled, onLeave, onLeaveCancelled, onBeforeAppear = onBeforeEnter, onAppear = onEnter, onAppearCancelled = onEnterCancelled } = baseProps;
		// 完成进入
		const finishEnter = (el, isAppear, done) => {
			removeTransitionClass(el, isAppear ? appearToClass : enterToClass);
			removeTransitionClass(el, isAppear ? appearActiveClass : enterActiveClass);
			done && done();
		};
		// 完成离开
		const finishLeave = (el, done) => {
			removeTransitionClass(el, leaveToClass);
			removeTransitionClass(el, leaveActiveClass);
			done && done();
		};
		// 确保进入
		const makeEnterHook = (isAppear) => {
			return (el, done) => {
				const hook = isAppear ? onAppear : onEnter;
				const resolve = () => finishEnter(el, isAppear, done);
				hook && hook(el, resolve);
				nextFrame(() => {
					removeTransitionClass(el, isAppear ? appearFromClass : enterFromClass);
					addTransitionClass(el, isAppear ? appearToClass : enterToClass);
					if (!(hook && hook.length > 1)) {
						if (enterDuration) {
							setTimeout(resolve, enterDuration);
						}
						else {
							whenTransitionEnds(el, type, resolve);
						}
					}
				});
			};
		};
		return extend(baseProps, {
			onBeforeEnter(el) {
				onBeforeEnter && onBeforeEnter(el);
				addTransitionClass(el, enterActiveClass);
				addTransitionClass(el, enterFromClass);
			},
			onBeforeAppear(el) {
				onBeforeAppear && onBeforeAppear(el);
				addTransitionClass(el, appearActiveClass);
				addTransitionClass(el, appearFromClass);
			},
			onEnter: makeEnterHook(false),
			onAppear: makeEnterHook(true),
			onLeave(el, done) {
				const resolve = () => finishLeave(el, done);
				addTransitionClass(el, leaveActiveClass);
				addTransitionClass(el, leaveFromClass);
				nextFrame(() => {
					removeTransitionClass(el, leaveFromClass);
					addTransitionClass(el, leaveToClass);
					if (!(onLeave && onLeave.length > 1)) {
						if (leaveDuration) {
							setTimeout(resolve, leaveDuration);
						}
						else {
							whenTransitionEnds(el, type, resolve);
						}
					}
				});
				onLeave && onLeave(el, resolve);
			},
			// 进入被中断hook
			onEnterCancelled(el) {
				finishEnter(el, false);
				onEnterCancelled && onEnterCancelled(el);
			},
			onAppearCancelled(el) {
				finishEnter(el, true);
				onAppearCancelled && onAppearCancelled(el);
			},
			// 离开被中断hook
			onLeaveCancelled(el) {
				finishLeave(el);
				onLeaveCancelled && onLeaveCancelled(el);
			}
		});
	}
	// 格式化duration
	function normalizeDuration(duration) {
		if (duration == null) {
			return null;
		}
		else if (isObject(duration)) {
			return [NumberOf(duration.enter), NumberOf(duration.leave)];
		}
		else {
			const n = NumberOf(duration);
			return [n, n];
		}
	}
	// 校验并返回数值类型value
	function NumberOf(val) {
		const res = toNumber(val);
		validateDuration(res);
		return res;
	}
	// 校验duration是否为一个number类型
	function validateDuration(val) {
		if (typeof val !== 'number') {
			warn(`<transition> explicit duration is not a valid number - ` +
				`got ${JSON.stringify(val)}.`);
		}
		else if (isNaN(val)) {
			warn(`<transition> explicit duration is NaN - ` +
				'the duration expression might be incorrect.');
		}
	}
	// 添加过渡样式
	function addTransitionClass(el, cls) {
		cls.split(/\s+/).forEach(c => c && el.classList.add(c));
		(el._vtc ||
			(el._vtc = new Set())).add(cls);
	}
	// 移除过渡样式
	function removeTransitionClass(el, cls) {
		cls.split(/\s+/).forEach(c => c && el.classList.remove(c));
		const { _vtc } = el;
		if (_vtc) {
			_vtc.delete(cls);
			if (!_vtc.size) {
				el._vtc = undefined;
			}
		}
	}
	// 下一帧动画
	function nextFrame(cb) {
		requestAnimationFrame(() => {
			requestAnimationFrame(cb);
		});
	}
	// 添加过渡结束动画
	function whenTransitionEnds(el, expectedType, cb) {
		const { type, timeout, propCount } = getTransitionInfo(el, expectedType);
		if (!type) {
			return cb();
		}
		const endEvent = type + 'end';
		let ended = 0;
		const end = () => {
			el.removeEventListener(endEvent, onEnd);
			cb();
		};
		const onEnd = (e) => {
			if (e.target === el) {
				if (++ended >= propCount) {
					end();
				}
			}
		};
		setTimeout(() => {
			if (ended < propCount) {
				end();
			}
		}, timeout + 1);
		el.addEventListener(endEvent, onEnd);
	}
	// 获取Element的过渡信息
	function getTransitionInfo(el, expectedType) {
		const styles = window.getComputedStyle(el);
		const getStyleProperties = (key) => (styles[key] || '').split(', ');
		// 过渡延迟时间 e.g. ['10s']
		const transitionDelays = getStyleProperties(TRANSITION + 'Delay');
		// 过渡时间 e.g. ['5s']
		const transitionDurations = getStyleProperties(TRANSITION + 'Duration');
		// 过渡超时时间 e.g. 15000 （把过渡延迟时间加上过渡时间）
		const transitionTimeout = getTimeout(transitionDelays, transitionDurations);
		// 动画延迟时间 e.g. '15s'
		const animationDelays = getStyleProperties(ANIMATION + 'Delay');
		// 动画过渡时间 e.g. '8s'
		const animationDurations = getStyleProperties(ANIMATION + 'Duration');
		// 动画超时时间 e.g. 23000
		const animationTimeout = getTimeout(animationDelays, animationDurations);
		let type = null;
		let timeout = 0;
		let propCount = 0;
		if (expectedType === TRANSITION) {
			if (transitionTimeout > 0) {
				type = TRANSITION;
				timeout = transitionTimeout;
				propCount = transitionDurations.length;
			}
		}
		else if (expectedType === ANIMATION) {
			if (animationTimeout > 0) {
				type = ANIMATION;
				timeout = animationTimeout;
				propCount = animationDurations.length;
			}
		}
		else {
			// 根据transitionTimeout 和 animationTimeout来判断是否需要过渡效果
			timeout = Math.max(transitionTimeout, animationTimeout);
			type =
				timeout > 0
					? transitionTimeout > animationTimeout
						? TRANSITION
						: ANIMATION
					: null;
			propCount = type
				? type === TRANSITION
					? transitionDurations.length
					: animationDurations.length
				: 0;
		}
		// 是否有过渡效果（Boolean值）
		const hasTransform = type === TRANSITION &&
			/\b(transform|all)(,|$)/.test(styles[TRANSITION + 'Property']);
		return {
			type,
			timeout,
			propCount,
			hasTransform
		};
	}
	/**
	 * 获取超时时间
	 * @param {Array} delays 延迟时间数组
	 * @param {Array} durations 过渡时间数组
	 * @returns 
	 */
	function getTimeout(delays, durations) {
		while (delays.length < durations.length) {
			delays = delays.concat(delays);
		}
		// 返回两个数组对应项相加后的最大值
		// e.g.
		// [1, 10, 2] [3, 5, 7]
		// 相加后 => [4, 15, 9]
		// Math.max([4, 15, 9]) => 15
		return Math.max(...durations.map((d, i) => toMs(d) + toMs(delays[i])));
	}
	// 旧版谷歌浏览器需将','转成'.'
	// e.g. s = '5s'
	// return 5000
	function toMs(s) {
		return Number(s.slice(0, -1).replace(',', '.')) * 1000;
	}
	// 存储当前位置信息
	const positionMap = new WeakMap();
	// 存储新的位置信息
	const newPositionMap = new WeakMap();
	// TransitionGroup组件
	const TransitionGroupImpl = {
		name: 'TransitionGroup',
		props: /*#__PURE__*/ extend({}, TransitionPropsValidators, {
			tag: String,
			moveClass: String
		}),
		setup(props, { slots }) {
			const instance = getCurrentInstance();
			const state = useTransitionState();
			let prevChildren;
			let children;
			// 添加updated生命周期hook
			onUpdated(() => {
				if (!prevChildren.length) {
					return;
				}
				const moveClass = props.moveClass || `${props.name || 'v'}-move`;
				// 如果没有过渡样式，则终止函数
				if (!hasCSSTransform(prevChildren[0].el, instance.vnode.el, moveClass)) {
					return;
				}
				// 触发旧子元素的正在等待中的钩子函数（e.g. 如果有delay延迟过渡属性，在更新时直接触发，无需再等待）
				prevChildren.forEach(callPendingCbs);
				prevChildren.forEach(recordPosition);
				const movedChildren = prevChildren.filter(applyTranslation);
				forceReflow();
				movedChildren.forEach(c => {
					const el = c.el;
					const style = el.style;
					addTransitionClass(el, moveClass);
					style.transform = style.webkitTransform = style.transitionDuration = '';
					const cb = (el._moveCb = (e) => {
						if (e && e.target !== el) {
							return;
						}
						if (!e || /transform$/.test(e.propertyName)) {
							el.removeEventListener('transitionend', cb);
							el._moveCb = null;
							removeTransitionClass(el, moveClass);
						}
					});
					el.addEventListener('transitionend', cb);
				});
			});
			return () => {
				const rawProps = toRaw(props);
				const cssTransitionProps = resolveTransitionProps(rawProps);
				const tag = rawProps.tag || Fragment;
				prevChildren = children;
				// transition-group标签里面的内容
				children = slots.default ? getTransitionRawChildren(slots.default()) : [];
				for (let i = 0; i < children.length; i++) {
					const child = children[i];
					if (child.key != null) {
						// 设置过渡钩子函数
						setTransitionHooks(child, resolveTransitionHooks(child, cssTransitionProps, state, instance));
					}
					else {
						// 子元素需要绑定key值
						warn(`<TransitionGroup> children must be keyed.`);
					}
				}
				if (prevChildren) {
					for (let i = 0; i < prevChildren.length; i++) {
						const child = prevChildren[i];
						setTransitionHooks(child, resolveTransitionHooks(child, cssTransitionProps, state, instance));
						positionMap.set(child, child.el.getBoundingClientRect());
					}
				}
				return createVNode(tag, null, children);
			};
		}
	};
	const TransitionGroup = TransitionGroupImpl;
	// 触发等待中的回调函数
	function callPendingCbs(c) {
		const el = c.el;
		if (el._moveCb) {
			el._moveCb();
		}
		if (el._enterCb) {
			el._enterCb();
		}
	}
	// 记录元素的位置信息
	function recordPosition(c) {
		newPositionMap.set(c, c.el.getBoundingClientRect());
	}
	// 应用过渡函数，添加过渡样式
	function applyTranslation(c) {
		const oldPos = positionMap.get(c);
		const newPos = newPositionMap.get(c);
		const dx = oldPos.left - newPos.left;
		const dy = oldPos.top - newPos.top;
		if (dx || dy) {
			const s = c.el.style;
			s.transform = s.webkitTransform = `translate(${dx}px,${dy}px)`;
			s.transitionDuration = '0s';
			return c;
		}
	}
	// 触发回流
	function forceReflow() {
		return document.body.offsetHeight;
	}
	// 判断el是否含有过渡样式（transitionProperty: 'transform|all' }
	function hasCSSTransform(el, root, moveClass) {
		const clone = el.cloneNode();
		if (el._vtc /* vue-transition-class */) {
			el._vtc.forEach(cls => {
				cls.split(/\s+/).forEach(c => c && clone.classList.remove(c));
			});
		}
		moveClass.split(/\s+/).forEach(c => c && clone.classList.add(c));
		clone.style.display = 'none';
		const container = (root.nodeType === 1
			? root
			: root.parentNode);
		container.appendChild(clone);
		const { hasTransform } = getTransitionInfo(clone);
		container.removeChild(clone);
		return hasTransform;
	}

	// 获取v-model绑定的事件
	// e.g. fn = $event => (count = $event)
	const getModelAssigner = (vnode) => {
		const fn = vnode.props['onUpdate:modelValue'];
		return isArray(fn) ? value => invokeArrayFns(fn, value) : fn;
	};
	function onCompositionStart(e) {
		e.target.composing = true;
	}
	function onCompositionEnd(e) {
		const target = e.target;
		// 防止input事件被无故的触发
		if (target.composing) {
			target.composing = false;
			trigger$1(target, 'input');
		}
	}
	function trigger$1(el, type) {
		// 创建自定义事件
		const e = document.createEvent('HTMLEvents');
		// 初始化自定义事件
		e.initEvent(type, true, true);
		// el触发自定义事件
		el.dispatchEvent(e);
	}
	// v-model绑定text类型的input
	// e.g. <input type="text" v-model="count">
	const vModelText = {
		created(el, { modifiers: { lazy, trim, number } }, vnode) {
			el._assign = getModelAssigner(vnode);
			const castToNumber = number || el.type === 'number';
			addEventListener(el, lazy ? 'change' : 'input', e => {
				if (e.target.composing)
					return;
				let domValue = el.value;
				if (trim) {
					domValue = domValue.trim();
				}
				else if (castToNumber) {
					domValue = toNumber(domValue);
				}
				// 触发v-model绑定的事件
				el._assign(domValue);
			});
			// 去掉两边空格修饰符
			if (trim) {
				addEventListener(el, 'change', () => {
					el.value = el.value.trim();
				});
			}
			if (!lazy) {
				// compositionstart 指中文输入法在输入时触发
				addEventListener(el, 'compositionstart', onCompositionStart);
				// compositionend 指中文输入法完成时触发
				addEventListener(el, 'compositionend', onCompositionEnd);
				// 有些浏览器没有compositionend事件，所以只能以change来替代
				addEventListener(el, 'change', onCompositionEnd);
			}
		},
		mounted(el, { value }) {
			// 赋值
			el.value = value == null ? '' : value;
		},
		beforeUpdate(el, { value, modifiers: { trim, number } }, vnode) {
			el._assign = getModelAssigner(vnode);
			if (el.composing)
				return;
			if (document.activeElement === el) {
				if (trim && el.value.trim() === value) {
					return;
				}
				if ((number || el.type === 'number') && toNumber(el.value) === value) {
					return;
				}
			}
			const newValue = value == null ? '' : value;
			if (el.value !== newValue) {
				el.value = newValue;
			}
		}
	};
	// v-model绑定checkbox类型的input
	const vModelCheckbox = {
		created(el, binding, vnode) {
			setChecked(el, binding, vnode);
			el._assign = getModelAssigner(vnode);
			addEventListener(el, 'change', () => {
				const modelValue = el._modelValue;
				const elementValue = getValue(el);
				const checked = el.checked;
				const assign = el._assign;
				if (isArray(modelValue)) {
					const index = looseIndexOf(modelValue, elementValue);
					const found = index !== -1;
					if (checked && !found) {
						assign(modelValue.concat(elementValue));
					}
					else if (!checked && found) {
						const filtered = [...modelValue];
						filtered.splice(index, 1);
						assign(filtered);
					}
				}
				else if (isSet(modelValue)) {
					if (checked) {
						modelValue.add(elementValue);
					}
					else {
						modelValue.delete(elementValue);
					}
				}
				else {
					assign(getCheckboxValue(el, checked));
				}
			});
		},
		beforeUpdate(el, binding, vnode) {
			el._assign = getModelAssigner(vnode);
			setChecked(el, binding, vnode);
		}
	};
	// 设置checkbox的checked值
	function setChecked(el, { value, oldValue }, vnode) {
		el._modelValue = value;
		if (isArray(value)) {
			el.checked = looseIndexOf(value, vnode.props.value) > -1;
		}
		else if (isSet(value)) {
			el.checked = value.has(vnode.props.value);
		}
		else if (value !== oldValue) {
			el.checked = looseEqual(value, getCheckboxValue(el, true));
		}
	}
	// 设置checkbox的checked值
	const vModelRadio = {
		created(el, { value }, vnode) {
			el.checked = looseEqual(value, vnode.props.value);
			el._assign = getModelAssigner(vnode);
			addEventListener(el, 'change', () => {
				el._assign(getValue(el));
			});
		},
		beforeUpdate(el, { value, oldValue }, vnode) {
			el._assign = getModelAssigner(vnode);
			if (value !== oldValue) {
				el.checked = looseEqual(value, vnode.props.value);
			}
		}
	};
	// v-model绑定select标签
	const vModelSelect = {
		created(el, { modifiers: { number } }, vnode) {
			addEventListener(el, 'change', () => {
				const selectedVal = Array.prototype.filter
					.call(el.options, (o) => o.selected)
					.map((o) => number ? toNumber(getValue(o)) : getValue(o));
				el._assign(el.multiple ? selectedVal : selectedVal[0]);
			});
			el._assign = getModelAssigner(vnode);
		},
		mounted(el, { value }) {
			setSelected(el, value);
		},
		beforeUpdate(el, _binding, vnode) {
			el._assign = getModelAssigner(vnode);
		},
		updated(el, { value }) {
			setSelected(el, value);
		}
	};
	// 设置下拉选中
	function setSelected(el, value) {
		// 是否为多选
		const isMultiple = el.multiple;
		if (isMultiple && !isArray(value) && !isSet(value)) {

			warn(`<select multiple v-model> expects an Array or Set value for its binding, ` +
				`but got ${Object.prototype.toString.call(value).slice(8, -1)}.`);
			return;
		}
		for (let i = 0, l = el.options.length; i < l; i++) {
			const option = el.options[i];
			const optionValue = getValue(option);
			if (isMultiple) {
				if (isArray(value)) {
					option.selected = looseIndexOf(value, optionValue) > -1;
				}
				else {
					option.selected = value.has(optionValue);
				}
			}
			else {
				if (looseEqual(getValue(option), value)) {
					el.selectedIndex = i;
					return;
				}
			}
		}
		if (!isMultiple) {
			el.selectedIndex = -1;
		}
	}
	// 获取el的value值
	function getValue(el) {
		return '_value' in el ? el._value : el.value;
	}
	// 获取checkbox的原始checked值
	function getCheckboxValue(el, checked) {
		const key = checked ? '_trueValue' : '_falseValue';
		return key in el ? el[key] : checked;
	}
	// v-model指令绑定动态标签，助手函数
	const vModelDynamic = {
		created(el, binding, vnode) {
			callModelHook(el, binding, vnode, null, 'created');
		},
		mounted(el, binding, vnode) {
			callModelHook(el, binding, vnode, null, 'mounted');
		},
		beforeUpdate(el, binding, vnode, prevVNode) {
			callModelHook(el, binding, vnode, prevVNode, 'beforeUpdate');
		},
		updated(el, binding, vnode, prevVNode) {
			callModelHook(el, binding, vnode, prevVNode, 'updated');
		}
	};
	// 公共函数 - 根据标签类型和触发v-model的生命周期钩子函数
	function callModelHook(el, binding, vnode, prevVNode, hook) {
		let modelToUse;
		switch (el.tagName) {
			case 'SELECT':
				modelToUse = vModelSelect;
				break;
			case 'TEXTAREA':
				modelToUse = vModelText;
				break;
			default:
				switch (vnode.props && vnode.props.type) {
					case 'checkbox':
						modelToUse = vModelCheckbox;
						break;
					case 'radio':
						modelToUse = vModelRadio;
						break;
					default:
						// 默认 v-model绑定文本类型的输入框
						modelToUse = vModelText;
				}
		}
		const fn = modelToUse[hook];
		fn && fn(el, binding, vnode, prevVNode);
	}

	const systemModifiers = ['ctrl', 'shift', 'alt', 'meta'];
	const modifierGuards = {
		stop: e => e.stopPropagation(),
		prevent: e => e.preventDefault(),
		self: e => e.target !== e.currentTarget,
		ctrl: e => !e.ctrlKey,
		shift: e => !e.shiftKey,
		alt: e => !e.altKey,
		meta: e => !e.metaKey,
		left: e => 'button' in e && e.button !== 0,
		middle: e => 'button' in e && e.button !== 1,
		right: e => 'button' in e && e.button !== 2,
		exact: (e, modifiers) => systemModifiers.some(m => e[`${m}Key`] && !modifiers.includes(m))
	};
	/**
	 * 添加事件修饰词拦截
	 * @private
	 */
	const withModifiers = (fn, modifiers) => {
		return (event, ...args) => {
			for (let i = 0; i < modifiers.length; i++) {
				const guard = modifierGuards[modifiers[i]];
				if (guard && guard(event, modifiers))
					return;
			}
			return fn(event, ...args);
		};
	};
	const keyNames = {
		esc: 'escape',
		space: ' ',
		up: 'arrow-up',
		left: 'arrow-left',
		right: 'arrow-right',
		down: 'arrow-down',
		delete: 'backspace'
	};
	/**
	 * 判断事件是不是键盘事件，并且判断key值是否为keyNames中提供的属性名
	 * @private
	 */
	const withKeys = (fn, modifiers) => {
		return (event) => {
			if (!('key' in event))
				return;
			const eventKey = hyphenate(event.key);
			if (
				// 如果事件修饰符不是keyNames对象中定义的值，则终止该函数
				!modifiers.some(k => k === eventKey || keyNames[k] === eventKey)) {
				return;
			}
			return fn(event);
		};
	};

	// v-show指令
	const vShow = {
		beforeMount(el, { value /* true/false */}, { transition /* transition标签 */ }) {
			el._vod = el.style.display === 'none' ? '' : el.style.display;
			if (transition && value) {
				// 触发transition组件的beforeEnter钩子
				transition.beforeEnter(el);
			}
			else {
				setDisplay(el, value);
			}
		},
		mounted(el, { value }, { transition }) {
			if (transition && value) {
				// 触发transition组件的enter钩子
				transition.enter(el);
			}
		},
		updated(el, { value, oldValue }, { transition }) {
			if (!value === !oldValue)
				return;
			if (transition) {
				if (value) {
					transition.beforeEnter(el);
					setDisplay(el, true);
					transition.enter(el);
				}
				else {
					transition.leave(el, () => {
						setDisplay(el, false);
					});
				}
			}
			else {
				setDisplay(el, value);
			}
		},
		beforeUnmount(el, { value }) {
			setDisplay(el, value);
		}
	};
	function setDisplay(el, value) {
		el.style.display = value ? el._vod : 'none';
	}

	const rendererOptions = extend({ patchProp, forcePatchProp }, nodeOps);
	// lazy create the renderer - this makes core renderer logic tree-shakable
	// in case the user only imports reactivity utilities from Vue.
	let renderer;
	let enabledHydration = false;
	// 确保renderer渲染函数存在
	function ensureRenderer() {
		return renderer || (renderer = createRenderer(rendererOptions));
	}
	function ensureHydrationRenderer() {
		renderer = enabledHydration
			? renderer
			: createHydrationRenderer(rendererOptions);
		enabledHydration = true;
		return renderer;
	}
	// use explicit type casts here to avoid import() calls in rolled-up d.ts
	const render = ((...args) => {
		ensureRenderer().render(...args);
	});
	const hydrate = ((...args) => {
		ensureHydrationRenderer().hydrate(...args);
	});
	// 创建一个Vue实例 -- createApp（公共API）
	const createApp = ((...args) => {
		const app = ensureRenderer().createApp(...args);
		{
			injectNativeTagCheck(app);
		}
		const { mount } = app;
		// 重新定义mount挂载元素 e.g. createApp({ data: {} }).mount("#app")
		app.mount = (containerOrSelector) => {
			const container = normalizeContainer(containerOrSelector);
			if (!container)
				return;
			// createApp创建Vue实例传递的options
			const component = app._component;
			if (!isFunction(component) && !component.render && !component.template) {
				component.template = container.innerHTML;
			}
			// 重置content，在mounting之前
			container.innerHTML = '';
			// 执行app原始的mount挂载元素
			const proxy = mount(container);
			// v-clock的作用是防止页面在加载时出现
			container.removeAttribute('v-cloak');
			container.setAttribute('data-v-app', '');
			return proxy;
		};
		return app;
	});
	// hydrate => 水合（通过服务端来渲染数据）
	const createSSRApp = ((...args) => {
		const app = ensureHydrationRenderer().createApp(...args);
		{
			injectNativeTagCheck(app);
		}
		const { mount } = app;
		app.mount = (containerOrSelector) => {
			const container = normalizeContainer(containerOrSelector);
			// createSSRApp必须传递template或者render方法
			// 而createApp如果两者都不传，则会将container.innerHTML作为template
			if (container) {
				return mount(container, true);
			}
		};
		return app;
	});
	/**
	 * 注入内置校验
	 * @param {Object} app createApp创建的app
	 */
	function injectNativeTagCheck(app) {
		Object.defineProperty(app.config, 'isNativeTag', {
			value: (tag) => isHTMLTag(tag) || isSVGTag(tag),
			writable: false
		});
	}
	// 格式化容器
	function normalizeContainer(container) {
		if (isString(container)) {
			const res = document.querySelector(container);
			if (!res) {
				warn(`Failed to mount app: mount target selector returned null.`);
			}
			return res;
		}
		return container;
	}

	// 初始化dev环境
	function initDev() {
		const target = getGlobalThis();
		target.__VUE__ = true;
		setDevtoolsHook(target.__VUE_DEVTOOLS_GLOBAL_HOOK__);
		{
			console.info(`You are running a development build of Vue.\n` +
				`Make sure to use the production build (*.prod.js) when deploying for production.`);
			initCustomFormatter();
		}
	}

	// 抛出默认错误
	function defaultOnError(error) {
		throw error;
	}
	/**
	 * 创建编译时的错误
	 * @param {Number} code 错误编码
	 * @param {Object} loc 编译位置
	 * @param {Object} messages 错误信息对象
	 * @param {String} additionalMessage 额外的错误信息
	 */
	function createCompilerError(code, loc, messages, additionalMessage) {
		const msg = (messages || errorMessages)[code] + (additionalMessage || ``)
			;
		const error = new SyntaxError(String(msg));
		error.code = code;
		error.loc = loc;
		return error;
	}
	const errorMessages = {
		// 解析错误类型，EOF错误，EOF是End Of File的缩写，便是文件结束
		[0 /* ABRUPT_CLOSING_OF_EMPTY_COMMENT ------ 非法注释 e.g. <!--> */]: 'Illegal comment.',
		[1 /* CDATA_IN_HTML_CONTENT ------ CDATA(XML的注释方式)只允许用在XML语言中 */]: 'CDATA section is allowed only in XML context.',
		[2 /* DUPLICATE_ATTRIBUTE ------ 属性名重复 */]: 'Duplicate attribute.',
		[3 /* END_TAG_WITH_ATTRIBUTES ------ 结束标签不能有属性 */]: 'End tag cannot have attributes.',
		[4 /* END_TAG_WITH_TRAILING_SOLIDUS */]: "Illegal '/' in tags.",
		[5 /* EOF_BEFORE_TAG_NAME ------ 解析标签错误 */]: 'Unexpected EOF in tag.',
		[6 /* EOF_IN_CDATA ------ 解析CDATA关闭符错误 */]: 'Unexpected EOF in CDATA section.',
		[7 /* EOF_IN_COMMENT ------ 解析注释错误 */]: 'Unexpected EOF in comment.',
		[8 /* EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT */]: 'Unexpected EOF in script.',
		[9 /* EOF_IN_TAG */]: 'Unexpected EOF in tag.',
		[10 /* INCORRECTLY_CLOSED_COMMENT ------ 已关闭的注释不正确 e.g. <!-- --!> */]: 'Incorrectly closed comment.',
		[11 /* INCORRECTLY_OPENED_COMMENT ------ 错误的注释节点 */]: 'Incorrectly opened comment.',
		[12 /* INVALID_FIRST_CHARACTER_OF_TAG_NAME ------ 非法标签名 */]: "Illegal tag name. Use '&lt;' to print '<'.",
		[13 /* MISSING_ATTRIBUTE_VALUE ------ 属性缺失属性值 */]: 'Attribute value was expected.',
		[14 /* MISSING_END_TAG_NAME ------ 缺少标签名 */]: 'End tag name was expected.',
		[15 /* MISSING_WHITESPACE_BETWEEN_ATTRIBUTES */]: 'Whitespace was expected.',
		[16 /* NESTED_COMMENT ------ 嵌套注释错误 */]: "Unexpected '<!--' in comment.",
		[17 /* UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME ------ 属性名不能包含 `"`, `'`, `<` */]: 'Attribute name cannot contain U+0022 ("), U+0027 (\'), and U+003C (<).',
		[18 /* UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE ------ 非引用值不能包含 `"`, `'`, `<`, `=`, ``` */]: 'Unquoted attribute value cannot contain U+0022 ("), U+0027 (\'), U+003C (<), U+003D (=), and U+0060 (`).',
		[19 /* UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME ------ 属性名不能以 `=` 号开头 */]: "Attribute name cannot start with '='.",
		[21 /* UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME ------ `<?` 只允许用在XML中 */]: "'<?' is allowed only in XML context.",
		[22 /* UNEXPECTED_SOLIDUS_IN_TAG ------ 非法属性 e.g. `/` */]: "Illegal '/' in tags.",
		// Vue-specific parse errors
		[23 /* X_INVALID_END_TAG ------ 无效的标签 */]: 'Invalid end tag.',
		[24 /* X_MISSING_END_TAG */]: 'Element is missing end tag.',
		[25 /* X_MISSING_INTERPOLATION_END */]: 'Interpolation end sign was not found.',
		[26 /* X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END ------ 动态绑定的指令缺少结束符（`]`） */]: 'End bracket for dynamic directive argument was not found. ' +
			'Note that dynamic directive argument cannot contain spaces.',
		// transform errors
		[27 /* X_V_IF_NO_EXPRESSION ------ v-if/v-else-if缺失表达式 */]: `v-if/v-else-if is missing expression.`,
		[28 /* X_V_IF_SAME_KEY */]: `v-if/else branches must use unique keys.`,
		[29 /* X_V_ELSE_NO_ADJACENT_IF ------ v-else/v-else-if相邻的标签没有v-if */]: `v-else/v-else-if has no adjacent v-if.`,
		[30 /* X_V_FOR_NO_EXPRESSION ------ v-for缺失表达式 */]: `v-for is missing expression.`,
		[31 /* X_V_FOR_MALFORMED_EXPRESSION ------ v-for含有无效表达式 */]: `v-for has invalid expression.`,
		[32 /* X_V_FOR_TEMPLATE_KEY_PLACEMENT */]: `<template v-for> key should be placed on the <template> tag.`,
		[33 /* X_V_BIND_NO_EXPRESSION */]: `v-bind is missing expression.`,
		[34 /* X_V_ON_NO_EXPRESSION */]: `v-on is missing expression.`,
		[35 /* X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET */]: `Unexpected custom directive on <slot> outlet.`,
		[36 /* X_V_SLOT_MIXED_SLOT_USAGE ------ 组件和嵌套的<template>上混合使用v-slot，当存在多个具名插槽时，所有插槽都应该使用<template>语法，以避免作用域发生歧义 */]: `Mixed v-slot usage on both the component and nested <template>.` +
			`When there are multiple named slots, all slots should use <template> ` +
			`syntax to avoid scope ambiguity.`,
		[37 /* X_V_SLOT_DUPLICATE_SLOT_NAMES ------ 重复的插槽名称 */]: `Duplicate slot names found. `,
		[38 /* X_V_SLOT_EXTRANEOUS_DEFAULT_SLOT_CHILDREN ------ 当组件已显示命名默认插槽时，发现无关的子级。这些孩子将会被忽视。 */]: `Extraneous children found when component already has explicitly named ` +
			`default slot. These children will be ignored.`,
		[39 /* X_V_SLOT_MISPLACED */]: `v-slot can only be used on components or <template> tags.`,
		[40 /* X_V_MODEL_NO_EXPRESSION */]: `v-model is missing expression.`,
		[41 /* X_V_MODEL_MALFORMED_EXPRESSION */]: `v-model value must be a valid JavaScript member expression.`,
		[42 /* X_V_MODEL_ON_SCOPE_VARIABLE */]: `v-model cannot be used on v-for or v-slot scope variables because they are not writable.`,
		[43 /* X_INVALID_EXPRESSION */]: `Error parsing JavaScript expression: `,
		[44 /* X_KEEP_ALIVE_INVALID_CHILDREN */]: `<KeepAlive> expects exactly one child component.`,
		// generic errors
		[45 /* X_PREFIX_ID_NOT_SUPPORTED */]: `"prefixIdentifiers" option is not supported in this build of compiler.`,
		[46 /* X_MODULE_MODE_NOT_SUPPORTED */]: `ES module mode is not supported in this build of compiler.`,
		[47 /* X_CACHE_HANDLER_NOT_SUPPORTED */]: `"cacheHandlers" option is only supported when the "prefixIdentifiers" option is enabled.`,
		[48 /* X_SCOPE_ID_NOT_SUPPORTED */]: `"scopeId" option is only supported in module mode.`
	};

	const FRAGMENT = Symbol(`Fragment`);
	const TELEPORT = Symbol(`Teleport`);
	const SUSPENSE = Symbol(`Suspense`);
	const KEEP_ALIVE = Symbol(`KeepAlive`);
	const BASE_TRANSITION = Symbol(`BaseTransition`);
	const OPEN_BLOCK = Symbol(`openBlock`);
	const CREATE_BLOCK = Symbol(`createBlock`);
	const CREATE_VNODE = Symbol(`createVNode`);
	const CREATE_COMMENT = Symbol(`createCommentVNode`);
	const CREATE_TEXT = Symbol(`createTextVNode`);
	const CREATE_STATIC = Symbol(`createStaticVNode`);
	const RESOLVE_COMPONENT = Symbol(`resolveComponent`);
	const RESOLVE_DYNAMIC_COMPONENT = Symbol(`resolveDynamicComponent`);
	const RESOLVE_DIRECTIVE = Symbol(`resolveDirective`);
	const WITH_DIRECTIVES = Symbol(`withDirectives`);
	const RENDER_LIST = Symbol(`renderList`);
	const RENDER_SLOT = Symbol(`renderSlot`);
	const CREATE_SLOTS = Symbol(`createSlots`);
	const TO_DISPLAY_STRING = Symbol(`toDisplayString`);
	const MERGE_PROPS = Symbol(`mergeProps`);
	const TO_HANDLERS = Symbol(`toHandlers`);
	const CAMELIZE = Symbol(`camelize`);
	const CAPITALIZE = Symbol(`capitalize`);
	const TO_HANDLER_KEY = Symbol(`toHandlerKey`);
	const SET_BLOCK_TRACKING = Symbol(`setBlockTracking`);
	const PUSH_SCOPE_ID = Symbol(`pushScopeId`);
	const POP_SCOPE_ID = Symbol(`popScopeId`);
	const WITH_SCOPE_ID = Symbol(`withScopeId`);
	const WITH_CTX = Symbol(`withCtx`);
	const helperNameMap = {
		[FRAGMENT]: `Fragment`,
		[TELEPORT]: `Teleport`,
		[SUSPENSE]: `Suspense`,
		[KEEP_ALIVE]: `KeepAlive`,
		[BASE_TRANSITION]: `BaseTransition`,
		[OPEN_BLOCK]: `openBlock`,
		[CREATE_BLOCK]: `createBlock`,
		[CREATE_VNODE]: `createVNode`,
		[CREATE_COMMENT]: `createCommentVNode`,
		[CREATE_TEXT]: `createTextVNode`,
		[CREATE_STATIC]: `createStaticVNode`,
		[RESOLVE_COMPONENT]: `resolveComponent`,
		[RESOLVE_DYNAMIC_COMPONENT]: `resolveDynamicComponent`,
		[RESOLVE_DIRECTIVE]: `resolveDirective`,
		[WITH_DIRECTIVES]: `withDirectives`,
		[RENDER_LIST]: `renderList`,
		[RENDER_SLOT]: `renderSlot`,
		[CREATE_SLOTS]: `createSlots`,
		[TO_DISPLAY_STRING]: `toDisplayString`,
		[MERGE_PROPS]: `mergeProps`,
		[TO_HANDLERS]: `toHandlers`,
		[CAMELIZE]: `camelize`,
		[CAPITALIZE]: `capitalize`,
		[TO_HANDLER_KEY]: `toHandlerKey`,
		[SET_BLOCK_TRACKING]: `setBlockTracking`,
		[PUSH_SCOPE_ID]: `pushScopeId`,
		[POP_SCOPE_ID]: `popScopeId`,
		[WITH_SCOPE_ID]: `withScopeId`,
		[WITH_CTX]: `withCtx`
	};
	// 注册运行期的助手函数
	function registerRuntimeHelpers(helpers) {
		// 返回一个给定对象自身的所有Symbol属性的数组
		Object.getOwnPropertySymbols(helpers).forEach(s => {
			helperNameMap[s] = helpers[s];
		});
	}

	// 默认根节点的位置信息
	const locStub = {
		source: '',
		start: { line: 1, column: 1, offset: 0 },
		end: { line: 1, column: 1, offset: 0 }
	};
	// 创建根节点
	function createRoot(children, loc = locStub) {
		return {
			type: 0 /* ROOT */,
			children,
			helpers: [],
			components: [],
			directives: [],
			hoists: [],
			imports: [],
			cached: 0,
			temps: 0,
			codegenNode: undefined,
			loc
		};
	}
	// 创建VNode的call函数
	function createVNodeCall(context, tag, props, children, patchFlag, dynamicProps, directives, isBlock = false, disableTracking = false, loc = locStub) {
		if (context) {
			if (isBlock) {
				context.helper(OPEN_BLOCK);
				context.helper(CREATE_BLOCK);
			}
			else {
				context.helper(CREATE_VNODE);
			}
			if (directives) {
				context.helper(WITH_DIRECTIVES);
			}
		}
		return {
			type: 13 /* VNODE_CALL */,
			tag,
			props,
			children,
			patchFlag,
			dynamicProps,
			directives,
			isBlock,
			disableTracking,
			loc
		};
	}
	// 创建数组形式表达式
	function createArrayExpression(elements, loc = locStub) {
		return {
			type: 17 /* JS_ARRAY_EXPRESSION */,
			loc,
			elements /* 数组 */
		};
	}
	// 创建对象形式表达式，其中properties为属性数组
	function createObjectExpression(properties, loc = locStub) {
		return {
			type: 15 /* JS_OBJECT_EXPRESSION */,
			loc,
			properties
		};
	}
	// 创建key/value形式的JS属性对象
	function createObjectProperty(key, value) {
		return {
			type: 16 /* JS_PROPERTY */,
			loc: locStub,
			key: isString(key) ? createSimpleExpression(key, true) : key,
			value
		};
	}
	// 创建简易的表达式对象
	function createSimpleExpression(content, isStatic, loc = locStub, isConstant = false) {
		return {
			type: 4 /* SIMPLE_EXPRESSION */,
			loc,
			isConstant,
			content,
			isStatic
		};
	}
	// 创建复杂的表达式对象
	function createCompoundExpression(children, loc = locStub) {
		return {
			type: 8 /* COMPOUND_EXPRESSION */,
			loc,
			children
		};
	}
	// 创建call的表达式对象
	function createCallExpression(callee, args = [], loc = locStub) {
		return {
			type: 14 /* JS_CALL_EXPRESSION */,
			loc,
			callee, /* callee表示引用的函数本身，在这里指的是：将调用该属性执行的函数来执行代码，传入args */
			arguments: args /* call执行传入的arguments */
		};
	}
	// 创建函数类型的表达式对象
	function createFunctionExpression(params, returns = undefined, newline = false, isSlot = false, loc = locStub) {
		return {
			type: 18 /* JS_FUNCTION_EXPRESSION */,
			params,
			returns,
			newline,
			isSlot,
			loc
		};
	}
	// 创建条件判断类型的表达式对象
	function createConditionalExpression(test, consequent, alternate, newline = true) {
		return {
			type: 19 /* JS_CONDITIONAL_EXPRESSION */,
			test,
			consequent,
			alternate,
			newline,
			loc: locStub
		};
	}
	// 创建缓存类型的表达式对象
	function createCacheExpression(index, value, isVNode = false) {
		return {
			type: 20 /* JS_CACHE_EXPRESSION */,
			index,
			value,
			isVNode,
			loc: locStub
		};
	}

	// 判断表达式是否为静态的
	const isStaticExp = (p) => p.type === 4 /* SIMPLE_EXPRESSION */ && p.isStatic;
	// 判断标签类型是否相等
	const isBuiltInType = (tag, expected) => tag === expected || tag === hyphenate(expected);
	// 根据标签名，判断是否为核心组件，返回组件的Symbol属性名
	function isCoreComponent(tag) {
		if (isBuiltInType(tag, 'Teleport')) {
			return TELEPORT;
		}
		else if (isBuiltInType(tag, 'Suspense')) {
			return SUSPENSE;
		}
		else if (isBuiltInType(tag, 'KeepAlive')) {
			return KEEP_ALIVE;
		}
		else if (isBuiltInType(tag, 'BaseTransition')) {
			return BASE_TRANSITION;
		}
	}
	// 判断传入参数是否为简单标识符
	const nonIdentifierRE = /^\d|[^\$\w]/;
	const isSimpleIdentifier = (name) => !nonIdentifierRE.test(name);

	const memberExpRE = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*|\[[^\]]+\])*$/;
	const isMemberExpression = (path) => {
		if (!path)
			return false;
		return memberExpRE.test(path.trim());
	};
	
	// 获取内区间
	function getInnerRange(loc, offset /* 偏移量 */, length /* 偏移长度 */) {
		const source = loc.source.substr(offset, length);
		const newLoc = {
			source,
			start: advancePositionWithClone(loc.start, loc.source, offset),
			end: loc.end
		};
		if (length != null) {
			newLoc.end = advancePositionWithClone(loc.start, loc.source, offset + length);
		}
		// 返回新的位置信息
		return newLoc;
	}
	// 以克隆源位置信息对象的方式推进位置（执行advancePositionWithMutation）
	// 推进长度默认为source字符串长度
	function advancePositionWithClone(pos, source, numberOfCharacters = source.length) {
		return advancePositionWithMutation(extend({}, pos), source, numberOfCharacters);
	}
	
	/**
	 * 推进位置发生改变（出现了换行符）
	 * @param {Object} pos 当前position信息
	 * @param {*} source 原始字符串
	 * @param {*} numberOfCharacters 推进长度，默认为原始字符串长度
	 */
	function advancePositionWithMutation(pos, source, numberOfCharacters = source.length) {
		let linesCount = 0; /* 记录换行次数 */
		let lastNewLinePos = -1; // 最后一个换行符所在索引（该索引小于numberOfCharacters）
		for (let i = 0; i < numberOfCharacters; i++) {
			if (source.charCodeAt(i) === 10 /* 换行键 */) {
				linesCount++;
				lastNewLinePos = i;
			}
		}
		pos.offset += numberOfCharacters; /* 当前偏移量加上推进字符串长度 */
		pos.line += linesCount;
		pos.column =
			lastNewLinePos === -1
				? pos.column + numberOfCharacters // 如果不出现换行符，则column等于当前column加上推进字符串长度
				: numberOfCharacters - lastNewLinePos; // 如果出现换行符，则column等于推进字符串长度减去最后一个换行符所在位置
		return pos;
	}
	// 类型断言
	function assert(condition, msg) {
		if (!condition) {
			throw new Error(msg || `unexpected compiler condition`);
		}
	}
	// 查找指令属性
	function findDir(node, name, allowEmpty = false /* 表达式是否允许为空 */) {
		for (let i = 0; i < node.props.length; i++) {
			const p = node.props[i];
			if (p.type === 7 /* DIRECTIVE */ &&
				(allowEmpty || p.exp) &&
				(isString(name) ? p.name === name : name.test(p.name))) {
				return p;
			}
		}
	}
	/**
	 * 查找node的属性
	 * @param {*} node Node
	 * @param {*} name 属性名称
	 * @param {*} dynamicOnly 
	 * @param {*} allowEmpty 
	 */
	function findProp(node, name, dynamicOnly = false, allowEmpty = false) {
		for (let i = 0; i < node.props.length; i++) {
			const p = node.props[i];
			if (p.type === 6 /* ATTRIBUTE */) {
				if (dynamicOnly)
					continue;
				if (p.name === name && (p.value || allowEmpty)) {
					return p;
				}
			}
			else if (p.name === 'bind' &&
				(p.exp || allowEmpty) &&
				isBindKey(p.arg, name)) {
				return p;
			}
		}
	}
	// 判断v-bind绑定的名称和传入的name是否相等
	function isBindKey(arg, name) {
		return !!(arg && isStaticExp(arg) && arg.content === name);
	}
	function hasDynamicKeyVBind(node) {
		return node.props.some(p => p.type === 7 /* DIRECTIVE */ &&
			p.name === 'bind' &&
			(!p.arg || // v-bind="obj"
				p.arg.type !== 4 /* SIMPLE_EXPRESSION */ || // v-bind:[_ctx.foo]
				!p.arg.isStatic) // v-bind:[foo]
		);
	}
	// 判断节点是否为文本节点
	function isText(node) {
		// 插值语法的文本 | 纯文本
		return node.type === 5 /* INTERPOLATION */ || node.type === 2 /* TEXT */;
	}
	// 判断prop是否为v-slot
	function isVSlot(p) {
		return p.type === 7 /* DIRECTIVE */ && p.name === 'slot';
	}
	// 判断节点是否为template标签
	function isTemplateNode(node) {
		return (node.type === 1 /* ELEMENT */ && node.tagType === 3 /* TEMPLATE */);
	}
	// 判断node节点是否为插槽出口类型<slot></slot>
	function isSlotOutlet(node) {
		return node.type === 1 /* ELEMENT */ && node.tagType === 2 /* SLOT */;
	}
	function injectProp(node, prop, context) {
		let propsWithInjection;
		const props = node.type === 13 /* VNODE_CALL */ ? node.props : node.arguments[2];
		if (props == null || isString(props)) {
			propsWithInjection = createObjectExpression([prop]);
		}
		else if (props.type === 14 /* JS_CALL_EXPRESSION */) {
			// merged props... add ours
			// only inject key to object literal if it's the first argument so that
			// if doesn't override user provided keys
			const first = props.arguments[0];
			if (!isString(first) && first.type === 15 /* JS_OBJECT_EXPRESSION */) {
				first.properties.unshift(prop);
			}
			else {
				if (props.callee === TO_HANDLERS) {
					// #2366
					propsWithInjection = createCallExpression(context.helper(MERGE_PROPS), [
						createObjectExpression([prop]),
						props
					]);
				}
				else {
					props.arguments.unshift(createObjectExpression([prop]));
				}
			}
			!propsWithInjection && (propsWithInjection = props);
		}
		else if (props.type === 15 /* JS_OBJECT_EXPRESSION */) {
			let alreadyExists = false;
			// check existing key to avoid overriding user provided keys
			if (prop.key.type === 4 /* SIMPLE_EXPRESSION */) {
				const propKeyName = prop.key.content;
				alreadyExists = props.properties.some(p => p.key.type === 4 /* SIMPLE_EXPRESSION */ &&
					p.key.content === propKeyName);
			}
			if (!alreadyExists) {
				props.properties.unshift(prop);
			}
			propsWithInjection = props;
		}
		else {
			// single v-bind with expression, return a merged replacement
			propsWithInjection = createCallExpression(context.helper(MERGE_PROPS), [
				createObjectExpression([prop]),
				props
			]);
		}
		if (node.type === 13 /* VNODE_CALL */) {
			node.props = propsWithInjection;
		}
		else {
			node.arguments[2] = propsWithInjection;
		}
	}

	/**
	 * 生成有效的断言ID
	 * @param {String} name 
	 * @param {String} type 
	 * e.g.
	 * name: 'child'
	 * type: 'component'
	 * 
	 * return '_component_child'
	 */
	function toValidAssetId(name, type) {
		return `_${type}_${name.replace(/[^\w]/g, '_')}`;
	}

	const decodeRE = /&(gt|lt|amp|apos|quot);/g;
	const decodeMap = {
		gt: '>',
		lt: '<',
		amp: '&',
		apos: "'",
		quot: '"'
	};
	// 默认的parse配置
	const defaultParserOptions = {
		delimiters: [`{{`, `}}`],
		getNamespace: () => 0 /* HTML */,
		getTextMode: () => 0 /* DATA */,
		isVoidTag: NO,
		isPreTag: NO,
		isCustomElement: NO,
		decodeEntities: (rawText) => rawText.replace(decodeRE, (_, p1) => decodeMap[p1]),
		onError: defaultOnError,
		comments: false
	};
	// 基础解析，将template解析成ast语法树
	function baseParse(content, options = {}) {
		const context = createParserContext(content, options);
		const start = getCursor(context);
		return createRoot(parseChildren(context, 0 /* DATA */, []), getSelection(context, start));
	}
	// 创建解析上下文
	function createParserContext(content, rawOptions) {
		const options = extend({}, defaultParserOptions);
		for (const key in rawOptions) {
			options[key] = rawOptions[key] || defaultParserOptions[key];
		}
		return {
			options,
			column: 1,
			line: 1,
			offset: 0,
			originalSource: content,
			source: content,
			inPre: false,
			inVPre: false
		};
	}
	// 解析子节点
	function parseChildren(context, mode, ancestors) {
		const parent = last(ancestors);
		const ns = parent ? parent.ns : 0 /* HTML */;
		const nodes = [];
		while (!isEnd(context, mode, ancestors)) {
			const s = context.source;
			let node = undefined;
			if (mode === 0 /* DATA */ || mode === 1 /* RCDATA */) {
				if (!context.inVPre && startsWith(s, context.options.delimiters[0])) {
					// 不存在v-pre，且是以 `{{` 开头
					node = parseInterpolation(context, mode);
				}
				else if (mode === 0 /* DATA */ && s[0] === '<') {
					if (s.length === 1) {
						emitError(context, 5 /* EOF_BEFORE_TAG_NAME */, 1);
					}
					else if (s[1] === '!') {
						// 注释节点
						if (startsWith(s, '<!--')) {
							node = parseComment(context);
						}
						else if (startsWith(s, '<!DOCTYPE')) {
							// 文档声明，当做注释处理
							node = parseBogusComment(context);
						}
						else if (startsWith(s, '<![CDATA[')) {
							if (ns !== 0 /* HTML */) {
								// 解析XML的注释，CDATA
								node = parseCDATA(context, ancestors);
							}
							else {
								emitError(context, 1 /* CDATA_IN_HTML_CONTENT */);
								node = parseBogusComment(context);
							}
						}
						else {
							emitError(context, 11 /* INCORRECTLY_OPENED_COMMENT */);
							node = parseBogusComment(context);
						}
					}
					else if (s[1] === '/') {
						if (s.length === 2) {
							emitError(context, 5 /* EOF_BEFORE_TAG_NAME */, 2);
						}
						else if (s[2] === '>') {
							emitError(context, 14 /* MISSING_END_TAG_NAME */, 2);
							advanceBy(context, 3);
							continue;
						}
						else if (/[a-z]/i.test(s[2])) {
							// 无效的标签 e.g. </a>
							emitError(context, 23 /* X_INVALID_END_TAG */);
							parseTag(context, 1 /* End */, parent);
							continue;
						}
						else {
							emitError(context, 12 /* INVALID_FIRST_CHARACTER_OF_TAG_NAME */, 2);
							node = parseBogusComment(context);
						}
					}
					else if (/[a-z]/i.test(s[1])) {
						node = parseElement(context, ancestors);
					}
					else if (s[1] === '?') {
						emitError(context, 21 /* UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME */, 1);
						node = parseBogusComment(context);
					}
					else {
						emitError(context, 12 /* INVALID_FIRST_CHARACTER_OF_TAG_NAME */, 1);
					}
				}
			}

			// node并未被赋值，意味着 `s` 是以文本开头
			if (!node) {
				node = parseText(context, mode);
			}
			if (isArray(node)) {
				for (let i = 0; i < node.length; i++) {
					pushNode(nodes, node[i]);
				}
			}
			else {
				pushNode(nodes, node);
			}
		}
		// Whitespace management for more efficient output
		// (same as v2 whitespace: 'condense')
		let removedWhitespace = false;
		if (mode !== 2 /* RAWTEXT */) {
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				if (!context.inPre && node.type === 2 /* TEXT */) {
					if (!/[^\t\r\n\f ]/.test(node.content)) {
						const prev = nodes[i - 1];
						const next = nodes[i + 1];
						// If:
						// - the whitespace is the first or last node, or:
						// - the whitespace is adjacent to a comment, or:
						// - the whitespace is between two elements AND contains newline
						// Then the whitespace is ignored.
						if (!prev ||
							!next ||
							prev.type === 3 /* COMMENT */ ||
							next.type === 3 /* COMMENT */ ||
							(prev.type === 1 /* ELEMENT */ &&
								next.type === 1 /* ELEMENT */ &&
								/[\r\n]/.test(node.content))) {
							removedWhitespace = true;
							nodes[i] = null;
						}
						else {
							// Otherwise, condensed consecutive whitespace inside the text
							// down to a single space
							node.content = ' ';
						}
					}
					else {
						node.content = node.content.replace(/[\t\r\n\f ]+/g, ' ');
					}
				}
			}
			if (context.inPre && parent && context.options.isPreTag(parent.tag)) {
				// remove leading newline per html spec
				// https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
				const first = nodes[0];
				if (first && first.type === 2 /* TEXT */) {
					first.content = first.content.replace(/^\r?\n/, '');
				}
			}
		}
		return removedWhitespace ? nodes.filter(Boolean) : nodes;
	}
	// 添加node
	function pushNode(nodes, node) {
		if (node.type === 2 /* TEXT */) {
			const prev = last(nodes);
			// 如果当前node节点和前一个node节点都是文本节点，且连续，则合并
			// e.g. `a < b`
			if (prev &&
				prev.type === 2 /* TEXT */ &&
				prev.loc.end.offset === node.loc.start.offset) {
				prev.content += node.content;
				prev.loc.end = node.loc.end;
				prev.loc.source += node.loc.source;
				return;
			}
		}
		nodes.push(node);
	}
	// 解析CDATA方式注释
	function parseCDATA(context, ancestors) {
		advanceBy(context, 9);
		const nodes = parseChildren(context, 3 /* CDATA */, ancestors);
		if (context.source.length === 0) {
			emitError(context, 6 /* EOF_IN_CDATA */);
		}
		else {
			advanceBy(context, 3);
		}
		return nodes;
	}
	// 解析注释节点
	function parseComment(context) {
		const start = getCursor(context);
		let content;
		// 匹配注释表示符 `-->`
		const match = /--(\!)?>/.exec(context.source);
		if (!match) {
			content = context.source.slice(4);
			advanceBy(context, context.source.length);
			emitError(context, 7 /* EOF_IN_COMMENT */);
		}
		else {
			if (match.index <= 3) {
				// e.g. <!-->
				emitError(context, 0 /* ABRUPT_CLOSING_OF_EMPTY_COMMENT */);
			}
			if (match[1]) {
				// e.g. <!-- --!>
				emitError(context, 10 /* INCORRECTLY_CLOSED_COMMENT */);
			}
			content = context.source.slice(4, match.index);
			// 出现嵌套注释时
			const s = context.source.slice(0, match.index);
			let prevIndex = 1, nestedIndex = 0;
			while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
				advanceBy(context, nestedIndex - prevIndex + 1);
				if (nestedIndex + 4 < s.length) {
					// e.g. <!-- <!-- --> 这个注释会报错
					emitError(context, 16 /* NESTED_COMMENT */);
				} // else e.g. <!-- <!----> 这个注释不会报错
				prevIndex = nestedIndex + 1;
			}
			advanceBy(context, match.index + match[0].length - prevIndex + 1);
		}
		return {
			type: 3 /* COMMENT */,
			content,
			loc: getSelection(context, start)
		};
	}
	// 解析非法的注释
	function parseBogusComment(context) {
		const start = getCursor(context);
		const contentStart = context.source[1] === '?' ? 1 : 2;
		let content;
		const closeIndex = context.source.indexOf('>');
		if (closeIndex === -1) {
			content = context.source.slice(contentStart);
			advanceBy(context, context.source.length);
		}
		else {
			content = context.source.slice(contentStart, closeIndex);
			advanceBy(context, closeIndex + 1);
		}
		return {
			type: 3 /* COMMENT */,
			content,
			loc: getSelection(context, start)
		};
	}
	// 解析元素
	function parseElement(context, ancestors) {
		const wasInPre = context.inPre;
		const wasInVPre = context.inVPre;
		const parent = last(ancestors);
		const element = parseTag(context, 0 /* Start */, parent);
		const isPreBoundary = context.inPre && !wasInPre;
		const isVPreBoundary = context.inVPre && !wasInVPre;
		if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
			return element;
		}
		// Children.
		ancestors.push(element);
		const mode = context.options.getTextMode(element, parent);
		const children = parseChildren(context, mode, ancestors);
		ancestors.pop();
		element.children = children;
		// End tag.
		if (startsWithEndTagOpen(context.source, element.tag)) {
			parseTag(context, 1 /* End */, parent);
		}
		else {
			emitError(context, 24 /* X_MISSING_END_TAG */, 0, element.loc.start);
			if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
				const first = children[0];
				if (first && startsWith(first.loc.source, '<!--')) {
					emitError(context, 8 /* EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT */);
				}
			}
		}
		element.loc = getSelection(context, element.loc.start);
		if (isPreBoundary) {
			context.inPre = false;
		}
		if (isVPreBoundary) {
			context.inVPre = false;
		}
		return element;
	}
	const isSpecialTemplateDirective = /*#__PURE__*/ makeMap(`if,else,else-if,for,slot`);
	/**
	 * 解析标签 e.g. `<div id=a>`
	 * 根据type来区分开始或者结束标签
	 */
	function parseTag(context, type, parent) {
		const start = getCursor(context);
		// 匹配 `<div` | `</div`
		const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source);
		const tag = match[1];
		const ns = context.options.getNamespace(tag, parent);
		advanceBy(context, match[0].length);
		advanceSpaces(context);
		// 保存当前位置信息，当匹配到v-pre属性时，重置context的位置信息为当前的位置信息
		// v-pre -> 跳过这个元素和它的子元素的编译过程
		const cursor = getCursor(context);
		const currentSource = context.source;
		// 解析属性
		let props = parseAttributes(context, type);
		// 检查pre标签
		if (context.options.isPreTag(tag)) {
			context.inPre = true;
		}
		// 检查 v-pre 属性
		if (!context.inVPre /* 初始值默认为false */ &&
			props.some(p => p.type === 7 /* DIRECTIVE */ && p.name === 'pre')) {
			context.inVPre = true;
			// 重置context
			extend(context, cursor);
			context.source = currentSource;
			// 重新解析属性并过滤掉v-pre属性
			props = parseAttributes(context, type).filter(p => p.name !== 'v-pre');
		}
		// Tag close.
		let isSelfClosing = false;
		if (context.source.length === 0) {
			emitError(context, 9 /* EOF_IN_TAG */);
		}
		else {
			isSelfClosing = startsWith(context.source, '/>');
			if (type === 1 /* End */ && isSelfClosing) {
				emitError(context, 4 /* END_TAG_WITH_TRAILING_SOLIDUS */);
			}
			advanceBy(context, isSelfClosing ? 2 : 1);
		}
		let tagType = 0 /* ELEMENT */;
		const options = context.options;
		if (!context.inVPre && !options.isCustomElement(tag)) {
			const hasVIs = props.some(p => p.type === 7 /* DIRECTIVE */ && p.name === 'is');
			if (options.isNativeTag && !hasVIs) {
				if (!options.isNativeTag(tag))
					tagType = 1 /* COMPONENT */;
			}
			else if (hasVIs ||
				isCoreComponent(tag) ||
				(options.isBuiltInComponent && options.isBuiltInComponent(tag)) ||
				/^[A-Z]/.test(tag) ||
				tag === 'component') {
				tagType = 1 /* COMPONENT */;
			}
			if (tag === 'slot') {
				tagType = 2 /* SLOT */;
			}
			else if (tag === 'template' &&
				props.some(p => {
					return (p.type === 7 /* DIRECTIVE */ && isSpecialTemplateDirective(p.name));
				})) {
				tagType = 3 /* TEMPLATE */;
			}
		}
		return {
			type: 1 /* ELEMENT */,
			ns,
			tag,
			tagType,
			props,
			isSelfClosing,
			children: [],
			loc: getSelection(context, start),
			codegenNode: undefined // to be created during transform phase
		};
	}
	// 解析attrs
	function parseAttributes(context, type) {
		const props = [];
		const attributeNames = new Set();
		while (context.source.length > 0 &&
			!startsWith(context.source, '>') &&
			!startsWith(context.source, '/>')) {
			if (startsWith(context.source, '/')) {
				emitError(context, 22 /* UNEXPECTED_SOLIDUS_IN_TAG */);
				advanceBy(context, 1);
				advanceSpaces(context);
				continue;
			}
			if (type === 1 /* End */) {
				emitError(context, 3 /* END_TAG_WITH_ATTRIBUTES */);
			}
			const attr = parseAttribute(context, attributeNames);
			if (type === 0 /* Start */) {
				props.push(attr);
			}
			if (/^[^\t\r\n\f />]/.test(context.source)) {
				emitError(context, 15 /* MISSING_WHITESPACE_BETWEEN_ATTRIBUTES */);
			}
			advanceSpaces(context);
		}
		return props;
	}
	// 解析attr
	function parseAttribute(context, nameSet) {
		// Name.
		const start = getCursor(context);
		// 匹配属性名
		// e.g. 
		// /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec('class="content">{{flag}}</p>\n  ')
		// => 'class'
		const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source);
		const name = match[0];
		if (nameSet.has(name)) {
			// 重复的属性名，报错
			emitError(context, 2 /* DUPLICATE_ATTRIBUTE */);
		}
		nameSet.add(name);
		if (name[0] === '=') {
			// e.g. <div =style=""></div>
			emitError(context, 19 /* UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME */);
		}
		{
			const pattern = /["'<]/g;
			let m;
			while ((m = pattern.exec(name))) {
				// e.g. <div "style=""></div>
				emitError(context, 17 /* UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME */, m.index);
			}
		}
		advanceBy(context, name.length);
		// Value
		let value = undefined;
		if (/^[\t\r\n\f ]*=/.test(context.source)) {
			advanceSpaces(context); // 去掉 `=` 号前面的空格（如果存在）
			advanceBy(context, 1); // 去掉 `=` 号
			advanceSpaces(context); // 去掉 `=` 号后面的空格（如果存在）
			// 属性值
			value = parseAttributeValue(context);
			if (!value) {
				emitError(context, 13 /* MISSING_ATTRIBUTE_VALUE */);
			}
		}
		const loc = getSelection(context, start);
		// 指令属性
		if (!context.inVPre && /^(v-|:|@|#)/.test(name)) {
			// e.g. v-slot:header.stop
			// 第一个子表达式匹配 slot
			// 第二个子表达式匹配 header
			// 第三个子表达式匹配 .stop
			const match = /(?:^v-([a-z0-9-]+))?(?:(?::|^@|^#)(\[[^\]]+\]|[^\.]+))?(.+)?$/i.exec(name);
			const dirName = match[1] ||
				(startsWith(name, ':') ? 'bind' : startsWith(name, '@') ? 'on' : 'slot');
			let arg;
			if (match[2]) {
				const isSlot = dirName === 'slot';
				const startOffset = name.indexOf(match[2]);
				// 以原生JavaScript表达式定义的属性值，可能会出现换行符
				const loc = getSelection(context, getNewPosition(context, start, startOffset), getNewPosition(context, start, startOffset + match[2].length + ((isSlot && match[3]) || '').length));
				let content = match[2]; // 事件名
				let isStatic = true;
				if (content.startsWith('[') /* 动态绑定事件类型 e.g. v-on:[event] */) {
					isStatic = false;
					if (!content.endsWith(']')) {
						emitError(context, 26 /* X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END */);
					}
					content = content.substr(1, content.length - 2); // 截取事件名 e.g. v-on:[event] => event
				}
				else if (isSlot) {
					// e.g. v-slot:header.stop
					content += match[3] || '';
				}
				arg = {
					type: 4 /* SIMPLE_EXPRESSION */,
					content,
					isStatic,
					isConstant: isStatic, // 是否为常量
					loc
				};
			}
			if (value && value.isQuoted) {
				const valueLoc = value.loc;
				valueLoc.start.offset++; // 去掉引号
				valueLoc.start.column++; // 去掉引号
				valueLoc.end = advancePositionWithClone(valueLoc.start, value.content);
				valueLoc.source = valueLoc.source.slice(1, -1);
			}
			return {
				type: 7 /* DIRECTIVE 指令类型 */,
				name: dirName,
				exp: value && {
					type: 4 /* SIMPLE_EXPRESSION */,
					content: value.content,
					isStatic: false,
					isConstant: false,
					loc: value.loc
				},
				arg,
				modifiers: match[3] ? match[3].substr(1).split('.') : [],
				loc
			};
		}
		return {
			type: 6 /* ATTRIBUTE 属性类型 */,
			name,
			value: value && {
				type: 2 /* TEXT */,
				content: value.content,
				loc: value.loc
			},
			loc
		};
	}
	// 解析属性名
	function parseAttributeValue(context) {
		const start = getCursor(context);
		let content;
		const quote = context.source[0];
		const isQuoted = quote === `"` || quote === `'`;
		if (isQuoted) {
			// 引用值
			advanceBy(context, 1);
			const endIndex = context.source.indexOf(quote);
			if (endIndex === -1) {
				content = parseTextData(context, context.source.length, 4 /* ATTRIBUTE_VALUE */);
			}
			else {
				content = parseTextData(context, endIndex, 4 /* ATTRIBUTE_VALUE */);
				advanceBy(context, 1);
			}
		}
		else {
			// 非引用值 TODO
			const match = /^[^\t\r\n\f >]+/.exec(context.source);
			if (!match) {
				return undefined;
			}
			const unexpectedChars = /["'<=`]/g;
			let m;
			while ((m = unexpectedChars.exec(match[0]))) {
				emitError(context, 18 /* UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE */, m.index);
			}
			content = parseTextData(context, match[0].length, 4 /* ATTRIBUTE_VALUE */);
		}
		return { content, isQuoted, loc: getSelection(context, start) };
	}
	// 解析插值语法 {{ }}
	function parseInterpolation(context, mode) {
		const [open, close] = context.options.delimiters;
		const closeIndex = context.source.indexOf(close, open.length);
		if (closeIndex === -1) {
			emitError(context, 25 /* X_MISSING_INTERPOLATION_END */);
			return undefined;
		}
		const start = getCursor(context);
		advanceBy(context, open.length);
		const innerStart = getCursor(context);
		const innerEnd = getCursor(context);
		const rawContentLength = closeIndex - open.length;
		const rawContent = context.source.slice(0, rawContentLength);
		const preTrimContent = parseTextData(context, rawContentLength, mode);
		const content = preTrimContent.trim();
		const startOffset = preTrimContent.indexOf(content);
		if (startOffset > 0) {
			advancePositionWithMutation(innerStart, rawContent, startOffset);
		}
		const endOffset = rawContentLength - (preTrimContent.length - content.length - startOffset);
		advancePositionWithMutation(innerEnd, rawContent, endOffset);
		advanceBy(context, close.length);
		return {
			type: 5 /* INTERPOLATION */,
			content: {
				type: 4 /* SIMPLE_EXPRESSION */,
				isStatic: false,
				// Set `isConstant` to false by default and will decide in transformExpression
				isConstant: false,
				content,
				loc: getSelection(context, innerStart, innerEnd)
			},
			loc: getSelection(context, start)
		};
	}
	// 解析文本节点
	function parseText(context, mode) {
		const endTokens = ['<', context.options.delimiters[0]]; /* ['<', '{{'] */
		if (mode === 3 /* CDATA */) {
			endTokens.push(']]>');
		}
		let endIndex = context.source.length;
		// 直到碰到 `<` | `{{` 时，结束循环
		for (let i = 0; i < endTokens.length; i++) {
			const index = context.source.indexOf(endTokens[i], 1);
			if (index !== -1 && endIndex > index) {
				endIndex = index;
			}
		}
		// 获取当前template索引下标的位置
		const start = getCursor(context);
		const content = parseTextData(context, endIndex, mode);
		return {
			type: 2 /* TEXT */,
			content,
			loc: getSelection(context, start)
		};
	}
	/**
	 * 从当前位置获取具有给定长度的文本数据
	 * 这可以翻译文本数据中的HTML实体 e.g. &nbsp; => 空格
	 */
	function parseTextData(context, length, mode) {
		const rawText = context.source.slice(0, length);
		advanceBy(context, length);
		if (mode === 2 /* RAWTEXT */ ||
			mode === 3 /* CDATA */ ||
			rawText.indexOf('&') === -1) {
			return rawText;
		}
		else {
			// 含有 `&` 符号 e.g. &nbsp;
			return context.options.decodeEntities(rawText, mode === 4 /* ATTRIBUTE_VALUE */);
		}
	}
	// 获取当前行、列、字符偏移量
	function getCursor(context) {
		const { column, line, offset } = context;
		return { column, line, offset };
	}
	// 获取选中字符串的开始位置、结束位置和当前选中字符串
	function getSelection(context, start, end) {
		end = end || getCursor(context);
		return {
			start,
			end,
			source: context.originalSource.slice(start.offset, end.offset)
		};
	}
	// 出栈方法，先进后出
	function last(xs) {
		return xs[xs.length - 1];
	}
	// 判断字符串是否以searchString开头
	function startsWith(source, searchString) {
		return source.startsWith(searchString);
	}
	// 字符串往前推移（切割前面的字符串）
	function advanceBy(context, numberOfCharacters) {
		const { source } = context;
		advancePositionWithMutation(context, source, numberOfCharacters);
		// 切割字符串
		context.source = source.slice(numberOfCharacters);
	}
	// 字符串往前推进（去掉字符串前面的空格）
	function advanceSpaces(context) {
		const match = /^[\t\r\n\f ]+/.exec(context.source);
		if (match) {
			advanceBy(context, match[0].length);
		}
	}
	// 获取新的位置信息
	function getNewPosition(context, start, numberOfCharacters) {
		return advancePositionWithClone(start, context.originalSource.slice(start.offset, numberOfCharacters), numberOfCharacters);
	}
	// 触发Error
	function emitError(context, code, offset, loc = getCursor(context)) {
		if (offset) {
			loc.offset += offset;
			loc.column += offset;
		}
		context.options.onError(createCompilerError(code, {
			start: loc,
			end: loc,
			source: ''
		}));
	}
	// 判断template是否已结束
	function isEnd(context, mode, ancestors) {
		const s = context.source;
		switch (mode) {
			case 0 /* DATA */:
				if (startsWith(s, '</')) {
					for (let i = ancestors.length - 1; i >= 0; --i) {
						if (startsWithEndTagOpen(s, ancestors[i].tag)) {
							return true;
						}
					}
				}
				break;
			case 1 /* RCDATA */:
			case 2 /* RAWTEXT */: {
				const parent = last(ancestors);
				if (parent && startsWithEndTagOpen(s, parent.tag)) {
					return true;
				}
				break;
			}
			case 3 /* CDATA */:
				if (startsWith(s, ']]>')) {
					return true;
				}
				break;
		}
		return !s;
	}
	// 判断是否是结束标签
	function startsWithEndTagOpen(source, tag) {
		return (startsWith(source, '</') &&
			source.substr(2, tag.length).toLowerCase() === tag.toLowerCase() &&
			/[\t\r\n\f />]/.test(source[2 + tag.length] || '>'));
	}
	// TODO
	function hoistStatic(root, context) {
		walk(root, context, new Map(),
			// Root node is unfortunately non-hoistable due to potential parent
			// fallthrough attributes.
			isSingleElementRoot(root, root.children[0]));
	}
	// 判断节点是否是单标签元素
	function isSingleElementRoot(root, child) {
		const { children } = root;
		return (children.length === 1 &&
			child.type === 1 /* ELEMENT */ &&
			!isSlotOutlet(child));
	}
	function walk(node, context, resultCache, doNotHoistNode = false) {
		let hasHoistedNode = false;
		// Some transforms, e.g. transformAssetUrls from @vue/compiler-sfc, replaces
		// static bindings with expressions. These expressions are guaranteed to be
		// constant so they are still eligible for hoisting, but they are only
		// available at runtime and therefore cannot be evaluated ahead of time.
		// This is only a concern for pre-stringification (via transformHoist by
		// @vue/compiler-dom), but doing it here allows us to perform only one full
		// walk of the AST and allow `stringifyStatic` to stop walking as soon as its
		// stringficiation threshold is met.
		let hasRuntimeConstant = false;
		const { children } = node;
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			// only plain elements & text calls are eligible for hoisting.
			if (child.type === 1 /* ELEMENT */ &&
				child.tagType === 0 /* ELEMENT */) {
				let staticType;
				if (!doNotHoistNode &&
					(staticType = getStaticType(child, resultCache)) > 0) {
					if (staticType === 2 /* HAS_RUNTIME_CONSTANT */) {
						hasRuntimeConstant = true;
					}
					child.codegenNode.patchFlag =
						-1 /* HOISTED */ + (` /* HOISTED */`);
					child.codegenNode = context.hoist(child.codegenNode);
					hasHoistedNode = true;
					continue;
				}
				else {
					// node may contain dynamic children, but its props may be eligible for
					// hoisting.
					const codegenNode = child.codegenNode;
					if (codegenNode.type === 13 /* VNODE_CALL */) {
						const flag = getPatchFlag(codegenNode);
						if ((!flag ||
							flag === 512 /* NEED_PATCH */ ||
							flag === 1 /* TEXT */) &&
							!hasNonHoistableProps(child)) {
							const props = getNodeProps(child);
							if (props) {
								codegenNode.props = context.hoist(props);
							}
						}
					}
				}
			}
			else if (child.type === 12 /* TEXT_CALL */) {
				const staticType = getStaticType(child.content, resultCache);
				if (staticType > 0) {
					if (staticType === 2 /* HAS_RUNTIME_CONSTANT */) {
						hasRuntimeConstant = true;
					}
					child.codegenNode = context.hoist(child.codegenNode);
					hasHoistedNode = true;
				}
			}
			// walk further
			if (child.type === 1 /* ELEMENT */) {
				walk(child, context, resultCache);
			}
			else if (child.type === 11 /* FOR */) {
				// Do not hoist v-for single child because it has to be a block
				walk(child, context, resultCache, child.children.length === 1);
			}
			else if (child.type === 9 /* IF */) {
				for (let i = 0; i < child.branches.length; i++) {
					// Do not hoist v-if single child because it has to be a block
					walk(child.branches[i], context, resultCache, child.branches[i].children.length === 1);
				}
			}
		}
		if (!hasRuntimeConstant && hasHoistedNode && context.transformHoist) {
			context.transformHoist(children, context, node);
		}
	}
	function getStaticType(node, resultCache = new Map()) {
		switch (node.type) {
			case 1 /* ELEMENT */:
				if (node.tagType !== 0 /* ELEMENT */) {
					return 0 /* NOT_STATIC */;
				}
				const cached = resultCache.get(node);
				if (cached !== undefined) {
					return cached;
				}
				const codegenNode = node.codegenNode;
				if (codegenNode.type !== 13 /* VNODE_CALL */) {
					return 0 /* NOT_STATIC */;
				}
				const flag = getPatchFlag(codegenNode);
				if (!flag && !hasNonHoistableProps(node)) {
					// element self is static. check its children.
					let returnType = 1 /* FULL_STATIC */;
					for (let i = 0; i < node.children.length; i++) {
						const childType = getStaticType(node.children[i], resultCache);
						if (childType === 0 /* NOT_STATIC */) {
							resultCache.set(node, 0 /* NOT_STATIC */);
							return 0 /* NOT_STATIC */;
						}
						else if (childType === 2 /* HAS_RUNTIME_CONSTANT */) {
							returnType = 2 /* HAS_RUNTIME_CONSTANT */;
						}
					}
					// check if any of the props contain runtime constants
					if (returnType !== 2 /* HAS_RUNTIME_CONSTANT */) {
						for (let i = 0; i < node.props.length; i++) {
							const p = node.props[i];
							if (p.type === 7 /* DIRECTIVE */ &&
								p.name === 'bind' &&
								p.exp &&
								(p.exp.type === 8 /* COMPOUND_EXPRESSION */ ||
									p.exp.isRuntimeConstant)) {
								returnType = 2 /* HAS_RUNTIME_CONSTANT */;
							}
						}
					}
					// only svg/foreignObject could be block here, however if they are
					// stati then they don't need to be blocks since there will be no
					// nested updates.
					if (codegenNode.isBlock) {
						codegenNode.isBlock = false;
					}
					resultCache.set(node, returnType);
					return returnType;
				}
				else {
					resultCache.set(node, 0 /* NOT_STATIC */);
					return 0 /* NOT_STATIC */;
				}
			case 2 /* TEXT */:
			case 3 /* COMMENT */:
				return 1 /* FULL_STATIC */;
			case 9 /* IF */:
			case 11 /* FOR */:
			case 10 /* IF_BRANCH */:
				return 0 /* NOT_STATIC */;
			case 5 /* INTERPOLATION */:
			case 12 /* TEXT_CALL */:
				return getStaticType(node.content, resultCache);
			case 4 /* SIMPLE_EXPRESSION */:
				return node.isConstant
					? node.isRuntimeConstant
						? 2 /* HAS_RUNTIME_CONSTANT */
						: 1 /* FULL_STATIC */
					: 0 /* NOT_STATIC */;
			case 8 /* COMPOUND_EXPRESSION */:
				let returnType = 1 /* FULL_STATIC */;
				for (let i = 0; i < node.children.length; i++) {
					const child = node.children[i];
					if (isString(child) || isSymbol(child)) {
						continue;
					}
					const childType = getStaticType(child, resultCache);
					if (childType === 0 /* NOT_STATIC */) {
						return 0 /* NOT_STATIC */;
					}
					else if (childType === 2 /* HAS_RUNTIME_CONSTANT */) {
						returnType = 2 /* HAS_RUNTIME_CONSTANT */;
					}
				}
				return returnType;
			default:
				return 0 /* NOT_STATIC */;
		}
	}
	/**
	 * Even for a node with no patch flag, it is possible for it to contain
	 * non-hoistable expressions that refers to scope variables, e.g. compiler
	 * injected keys or cached event handlers. Therefore we need to always check the
	 * codegenNode's props to be sure.
	 */
	function hasNonHoistableProps(node) {
		const props = getNodeProps(node);
		if (props && props.type === 15 /* JS_OBJECT_EXPRESSION */) {
			const { properties } = props;
			for (let i = 0; i < properties.length; i++) {
				const { key, value } = properties[i];
				if (key.type !== 4 /* SIMPLE_EXPRESSION */ ||
					!key.isStatic ||
					(value.type !== 4 /* SIMPLE_EXPRESSION */ ||
						(!value.isStatic && !value.isConstant))) {
					return true;
				}
			}
		}
		return false;
	}
	function getNodeProps(node) {
		const codegenNode = node.codegenNode;
		if (codegenNode.type === 13 /* VNODE_CALL */) {
			return codegenNode.props;
		}
	}
	function getPatchFlag(node) {
		const flag = node.patchFlag;
		return flag ? parseInt(flag, 10) : undefined;
	}

	// 创建转换上下文
	function createTransformContext(root, { prefixIdentifiers = false, hoistStatic = false, cacheHandlers = false, nodeTransforms = [], directiveTransforms = {}, transformHoist = null, isBuiltInComponent = NOOP, isCustomElement = NOOP, expressionPlugins = [], scopeId = null, ssr = false, ssrCssVars = ``, bindingMetadata = {}, onError = defaultOnError }) {
		const context = {
			prefixIdentifiers,
			hoistStatic,
			cacheHandlers,
			nodeTransforms,
			directiveTransforms,
			transformHoist,
			isBuiltInComponent,
			isCustomElement,
			expressionPlugins,
			scopeId,
			ssr,
			ssrCssVars,
			bindingMetadata,
			onError,
			// state
			root,
			helpers: new Set(),
			components: new Set(),
			directives: new Set(),
			hoists: [],
			imports: new Set(),
			temps: 0,
			cached: 0,
			identifiers: Object.create(null),
			scopes: {
				vFor: 0,
				vSlot: 0,
				vPre: 0,
				vOnce: 0
			},
			parent: null,
			currentNode: root,
			childIndex: 0,
			// 添加助手函数
			helper(name) {
				context.helpers.add(name);
				return name;
			},
			helperString(name) {
				return `_${helperNameMap[context.helper(name)]}`;
			},
			// 替换当前node节点
			replaceNode(node) {
				{
					if (!context.currentNode) {
						throw new Error(`Node being replaced is already removed.`);
					}
					if (!context.parent) {
						throw new Error(`Cannot replace root node.`);
					}
				}
				context.parent.children[context.childIndex] = context.currentNode = node;
			},
			// 移除节点
			removeNode(node) {
				if (!context.parent) {
					throw new Error(`Cannot remove root node.`);
				}
				const list = context.parent.children;
				const removalIndex = node
					? list.indexOf(node)
					: context.currentNode
						? context.childIndex
						: -1;
				if (removalIndex < 0) {
					throw new Error(`node being removed is not a child of current parent`);
				}
				if (!node || node === context.currentNode) {
					context.currentNode = null;
					context.onNodeRemoved();
				}
				else {
					if (context.childIndex > removalIndex) {
						context.childIndex--;
						context.onNodeRemoved();
					}
				}
				context.parent.children.splice(removalIndex, 1);
			},
			onNodeRemoved: () => { },
			addIdentifiers(exp) {
			},
			removeIdentifiers(exp) {
			},
			// 添加静态提升表达式
			hoist(exp) {
				context.hoists.push(exp);
				const identifier = createSimpleExpression(`_hoisted_${context.hoists.length}`, false, exp.loc, true);
				identifier.hoisted = exp;
				return identifier;
			},
			// 添加缓存节点表达式
			cache(exp, isVNode = false) {
				return createCacheExpression(++context.cached, exp, isVNode);
			}
		};
		return context;
	}
	// 转换ast语法树
	function transform(root, options) {
		const context = createTransformContext(root, options);
		traverseNode(root, context);
		if (options.hoistStatic) {
			hoistStatic(root, context);
		}
		if (!options.ssr) {
			createRootCodegen(root, context);
		}
		// finalize meta information
		root.helpers = [...context.helpers];
		root.components = [...context.components];
		root.directives = [...context.directives];
		root.imports = [...context.imports];
		root.hoists = context.hoists;
		root.temps = context.temps;
		root.cached = context.cached;
	}
	function createRootCodegen(root, context) {
		const { helper } = context;
		const { children } = root;
		if (children.length === 1) {
			const child = children[0];
			// if the single child is an element, turn it into a block.
			if (isSingleElementRoot(root, child) && child.codegenNode) {
				// single element root is never hoisted so codegenNode will never be
				// SimpleExpressionNode
				const codegenNode = child.codegenNode;
				if (codegenNode.type === 13 /* VNODE_CALL */) {
					codegenNode.isBlock = true;
					helper(OPEN_BLOCK);
					helper(CREATE_BLOCK);
				}
				root.codegenNode = codegenNode;
			}
			else {
				// - single <slot/>, IfNode, ForNode: already blocks.
				// - single text node: always patched.
				// root codegen falls through via genNode()
				root.codegenNode = child;
			}
		}
		else if (children.length > 1) {
			// root has multiple nodes - return a fragment block.
			root.codegenNode = createVNodeCall(context, helper(FRAGMENT), undefined, root.children, `${64 /* STABLE_FRAGMENT */} /* ${PatchFlagNames[64 /* STABLE_FRAGMENT */]} */`, undefined, undefined, true);
		}
		else;
	}
	// 转换VNode的children
	function traverseChildren(parent, context) {
		let i = 0;
		const nodeRemoved = () => {
			i--;
		};
		for (; i < parent.children.length; i++) {
			const child = parent.children[i];
			if (isString(child))
				continue;
			context.parent = parent;
			context.childIndex = i;
			context.onNodeRemoved = nodeRemoved;
			traverseNode(child, context);
		}
	}
	// 转换VNode
	function traverseNode(node, context) {
		context.currentNode = node;
		// 应用转换插件
		const { nodeTransforms } = context;
		const exitFns = [];
		for (let i = 0; i < nodeTransforms.length; i++) {
			// 执行转换插件返回的回调
			const onExit = nodeTransforms[i](node, context);
			if (onExit) {
				if (isArray(onExit)) {
					exitFns.push(...onExit);
				}
				else {
					exitFns.push(onExit);
				}
			}
			if (!context.currentNode) {
				// node节点已被移除
				return;
			}
			else {
				// 执行转换插件后，当前node节点可能被替换掉了
				node = context.currentNode;
			}
		}
		switch (node.type) {
			case 3 /* COMMENT */:
				if (!context.ssr) {
					// inject import for the Comment symbol, which is needed for creating
					// comment nodes with `createVNode`
					context.helper(CREATE_COMMENT);
				}
				break;
			case 5 /* INTERPOLATION */:
				// no need to traverse, but we need to inject toString helper
				if (!context.ssr) {
					context.helper(TO_DISPLAY_STRING);
				}
				break;
			// for container types, further traverse downwards
			case 9 /* IF */:
				for (let i = 0; i < node.branches.length; i++) {
					traverseNode(node.branches[i], context);
				}
				break;
			case 10 /* IF_BRANCH */:
			case 11 /* FOR */:
			case 1 /* ELEMENT */:
			case 0 /* ROOT */:
				traverseChildren(node, context);
				break;
		}
		// 执行回调
		context.currentNode = node;
		let i = exitFns.length;
		while (i--) {
			exitFns[i]();
		}
	}
	/**
	 * 创建结构指令转换函数（traverseNode）
	 * @param {String} name 指令名称或指令匹配正则表达式
	 * @param {Function} fn 回调函数
	 */
	function createStructuralDirectiveTransform(name, fn) {
		const matches = isString(name)
			? (n) => n === name
			: (n) => name.test(n);
		return (node, context) => {
			if (node.type === 1 /* ELEMENT */) {
				const { props } = node;
				// 结构指令与插槽无关，因为它们是用插槽转换函数单独处理的
				if (node.tagType === 3 /* TEMPLATE */ && props.some(isVSlot)) {
					return;
				}
				const exitFns = [];
				for (let i = 0; i < props.length; i++) {
					const prop = props[i];
					if (prop.type === 7 /* DIRECTIVE */ && matches(prop.name)) {
						// 移除结构指令，以避免无限递归
						// 在应用它之前移除
						// 这样它就可以进一步遍历自己，以防它四处移动节点
						props.splice(i, 1);
						i--;
						// 执行回调
						const onExit = fn(node, prop, context);
						if (onExit)
							exitFns.push(onExit);
					}
				}
				return exitFns;
			}
		};
	}

	// 添加tree-shaking注释
	const PURE_ANNOTATION = `/*#__PURE__*/`;
	// 创建生成代码上下文
	function createCodegenContext(ast, { mode = 'function', prefixIdentifiers = mode === 'module', sourceMap = false, filename = `template.vue.html`, scopeId = null, optimizeImports = false, runtimeGlobalName = `Vue`, runtimeModuleName = `vue`, ssr = false }) {
		const context = {
			mode,
			prefixIdentifiers,
			sourceMap,
			filename,
			scopeId,
			optimizeImports,
			runtimeGlobalName,
			runtimeModuleName,
			ssr,
			source: ast.loc.source,
			code: ``,
			column: 1,
			line: 1,
			offset: 0,
			indentLevel: 0, // 代码缩进大小
			pure: false,
			map: undefined,
			// 添加运行期间的助手函数
			helper(key) {
				return `_${helperNameMap[key]}`;
			},
			// 拼接代码（添加代码）
			push(code, node) {
				context.code += code;
			},
			// 添加缩进并换行
			indent() {
				newline(++context.indentLevel);
			},
			// 减少缩进（根据参数确定是否需要换行）
			deindent(withoutNewLine = false /* 是否需要换行减少缩进 */) {
				if (withoutNewLine) {
					--context.indentLevel;
				}
				else {
					newline(--context.indentLevel);
				}
			},
			// 添加换行
			newline() {
				newline(context.indentLevel);
			}
		};
		// 添加换行
		function newline(n /* 重复数量 e.g. 为0时，空格数为0 */) {
			context.push('\n' + `  `.repeat(n));
		}
		return context;
	}
	/*
		生成代码code
		e.g. 
		(function anaymous() {
			const _Vue = Vue
			return function render(_ctx, _cache) {
				with(_ctx) {
					// withProx.Vue => 会触发RuntimeCompiledPublicInstanceProxyHandlers的has方法
					const { toDisplayString: _toDisplayString } = _Vue
					return _toDisplayString(counter)
				}
			}
		})
	*/
	function generate(ast, options = {}) {
		// 上下文
		const context = createCodegenContext(ast, options);
		// 执行创建上下文的回调钩子
		if (options.onContextCreated)
			options.onContextCreated(context);
		const { mode, push, prefixIdentifiers, indent, deindent, newline, scopeId, ssr } = context;
		// 是否含有助手函数
		const hasHelpers = ast.helpers.length > 0;
		// 使用with语法（ES module模式下，不能使用with）
		const useWithBlock = !prefixIdentifiers && mode !== 'module';
		// 首先生成函数的序言
		{
			genFunctionPreamble(ast, context);
		}
		// 绑定最优化options
		const optimizeSources = options.bindingMetadata
			? `, $props, $setup, $data, $options`
			: ``;
		// 添加渲染函数render
		if (!ssr) {
			push(`function render(_ctx, _cache${optimizeSources}) {`);
		}
		else {
			push(`function ssrRender(_ctx, _push, _parent, _attrs${optimizeSources}) {`);
		}
		indent();
		if (useWithBlock) {
			push(`with (_ctx) {`);
			indent();
			// 如果需要使用助手函数，则将其解构出来
			if (hasHelpers) {
				push(`const { ${ast.helpers
					.map(s => `${helperNameMap[s]}: _${helperNameMap[s]}`)
					.join(', ')} } = _Vue`);
				push(`\n`);
				newline();
			}
		}
		// 生成解析组件代码
		if (ast.components.length) {
			genAssets(ast.components, 'component', context);
			if (ast.directives.length || ast.temps > 0) {
				newline();
			}
		}
		// 生成解析指令代码
		if (ast.directives.length) {
			genAssets(ast.directives, 'directive', context);
			if (ast.temps > 0) {
				newline();
			}
		}
		if (ast.temps > 0) {
			push(`let `);
			for (let i = 0; i < ast.temps; i++) {
				push(`${i > 0 ? `, ` : ``}_temp${i}`);
			}
		}
		// 添加换行符
		if (ast.components.length || ast.directives.length || ast.temps) {
			push(`\n`);
			newline();
		}
		// 生成节点树的表达式代码
		if (!ssr) {
			push(`return `);
		}
		if (ast.codegenNode) {
			genNode(ast.codegenNode, context);
		}
		else {
			push(`null`);
		}
		if (useWithBlock) {
			deindent();
			push(`}`);
		}
		deindent();
		push(`}`);
		return {
			ast,
			code: context.code,
			// SourceMapGenerator does have toJSON() method but it's not in the types
			map: context.map ? context.map.toJSON() : undefined
		};
	}
	/**
	 * 生成函数的序言
	 * @param {Object} ast ast语法树
	 * @param {Object} context 上下文
	 */
	function genFunctionPreamble(ast, context) {
		const { ssr, prefixIdentifiers, push, newline, runtimeModuleName, runtimeGlobalName } = context;
		const VueBinding = runtimeGlobalName;
		// 根据助手名称返回别名 e.g. return `createVNode: _createVNode`
		const aliasHelper = (s) => `${helperNameMap[s]}: _${helperNameMap[s]}`;
		// 如果需要助手函数转换，则创建解构对象
		if (ast.helpers.length > 0) {
			{
				// e.g. const _Vue = Vue
				push(`const _Vue = ${VueBinding}\n`);
				// 静态助手函数 e.g. 'createVNode: _createVNode, createCommentVNode: _createCommentVNode'
				if (ast.hoists.length) {
					const staticHelpers = [
						CREATE_VNODE, // 创建VNode
						CREATE_COMMENT, // 创建注释节点
						CREATE_TEXT, // 创建文本节点
						CREATE_STATIC // 创建静态节点
					]
						.filter(helper => ast.helpers.includes(helper))
						.map(aliasHelper)
						.join(', ');
					// e.g. const { createVNode: _createVNode, createCommentVNode: _createCommentVNode } = _Vue
					push(`const { ${staticHelpers} } = _Vue\n`);
				}
			}
		}
		genHoists(ast.hoists, context);
		newline();
		push(`return `);
	}
	/**
	 * 生成组件或指令代码
	 * @param {*} assets 
	 * @param {*} type 类型 e.g. component, directive
	 * @param {*} param2 context
	 */
	function genAssets(assets, type, { helper, push, newline }) {
		const resolver = helper(type === 'component' ? RESOLVE_COMPONENT : RESOLVE_DIRECTIVE);
		for (let i = 0; i < assets.length; i++) {
			const id = assets[i];
			push(`const ${toValidAssetId(id, type)} = ${resolver}(${JSON.stringify(id)})`);
			if (i < assets.length - 1) {
				newline();
			}
		}
	}
	/**
	 * 生成静态提升代码
	 * @param {*} hoists 
	 * @param {*} context 
	 * @returns 
	 */
	function genHoists(hoists, context) {
		if (!hoists.length) {
			return;
		}
		// 标记是否为纯粹的（可以tree-shaking）
		context.pure = true;
		const { push, newline, helper, scopeId, mode } = context;
		newline();
		hoists.forEach((exp, i) => {
			if (exp) {
				push(`const _hoisted_${i + 1} = `);
				genNode(exp, context);
				newline();
			}
		});
		context.pure = false;
	}
	// 判断节点是否为文本类型节点
	function isText$1(n) {
		return (isString(n) ||
			n.type === 4 /* SIMPLE_EXPRESSION */ ||
			n.type === 2 /* TEXT */ ||
			n.type === 5 /* INTERPOLATION */ ||
			n.type === 8 /* COMPOUND_EXPRESSION */);
	}
	/**
	 * 生成组件节点列表
	 */
	function genNodeListAsArray(nodes, context) {
		const multilines = nodes.length > 3 ||
			(nodes.some(n => isArray(n) || !isText$1(n)));
		context.push(`[`);
		multilines && context.indent();
		genNodeList(nodes, context, multilines);
		multilines && context.deindent();
		context.push(`]`);
	}
	/**
	 * 生成node节点列表
	 * @param {*} nodes 节点列表 
	 * @param {*} context 上下文
	 * @param {*} multilines 是否需要换行
	 * @param {*} comma 是否需要添加逗号 `,`
	 */
	function genNodeList(nodes, context, multilines = false, comma = true) {
		const { push, newline } = context;
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			if (isString(node)) { // e.g. `null`
				push(node);
			}
			else if (isArray(node)) { // 子节点列表
				genNodeListAsArray(node, context);
			}
			else {
				genNode(node, context);
			}
			if (i < nodes.length - 1) {
				if (multilines) {
					comma && push(',');
					newline();
				}
				else {
					comma && push(', ');
				}
			}
		}
	}
	/**
	 * 生成节点代码
	 */
	function genNode(node, context) {
		// 如果节点类型为string类型，则直接添加代码
		if (isString(node)) {
			context.push(node);
			return;
		}
		// 如果节点为Symbol类型，则直接添加代码
		if (isSymbol(node)) {
			context.push(context.helper(node));
			return;
		}
		switch (node.type) {
			case 1 /* ELEMENT */:
			case 9 /* IF */:
			case 11 /* FOR */:

				assert(node.codegenNode != null, `Codegen node is missing for element/if/for node. ` +
					`Apply appropriate transforms first.`);
				genNode(node.codegenNode, context);
				break;
			case 2 /* TEXT */:
				genText(node, context);
				break;
			case 4 /* SIMPLE_EXPRESSION */:
				genExpression(node, context);
				break;
			case 5 /* INTERPOLATION */:
				genInterpolation(node, context);
				break;
			case 12 /* TEXT_CALL */:
				genNode(node.codegenNode, context);
				break;
			case 8 /* COMPOUND_EXPRESSION */:
				genCompoundExpression(node, context);
				break;
			case 3 /* COMMENT */:
				genComment(node, context);
				break;
			case 13 /* VNODE_CALL */:
				genVNodeCall(node, context);
				break;
			case 14 /* JS_CALL_EXPRESSION */:
				genCallExpression(node, context);
				break;
			case 15 /* JS_OBJECT_EXPRESSION */:
				genObjectExpression(node, context);
				break;
			case 17 /* JS_ARRAY_EXPRESSION */:
				genArrayExpression(node, context);
				break;
			case 18 /* JS_FUNCTION_EXPRESSION */:
				genFunctionExpression(node, context);
				break;
			case 19 /* JS_CONDITIONAL_EXPRESSION */:
				genConditionalExpression(node, context);
				break;
			case 20 /* JS_CACHE_EXPRESSION */:
				genCacheExpression(node, context);
				break;
			// SSR only types
			case 21 /* JS_BLOCK_STATEMENT */:
				break;
			case 22 /* JS_TEMPLATE_LITERAL */:
				break;
			case 23 /* JS_IF_STATEMENT */:
				break;
			case 24 /* JS_ASSIGNMENT_EXPRESSION */:
				break;
			case 25 /* JS_SEQUENCE_EXPRESSION */:
				break;
			case 26 /* JS_RETURN_STATEMENT */:
				break;
			/* istanbul ignore next */
			case 10 /* IF_BRANCH */:
				// noop
				break;
			default:
				{
					assert(false, `unhandled codegen node type: ${node.type}`);
					// make sure we exhaust all possible types
					const exhaustiveCheck = node;
					return exhaustiveCheck;
				}
		}
	}
	/**
	 * 生成文本代码
	 */
	function genText(node, context) {
		context.push(JSON.stringify(node.content), node);
	}
	/**
	 * 生成表达式代码
	 */
	function genExpression(node, context) {
		const { content, isStatic } = node;
		context.push(isStatic ? JSON.stringify(content) : content, node);
	}
	/**
	 * 生成插值语法代码
	 */
	function genInterpolation(node, context) {
		const { push, helper, pure } = context;
		if (pure)
			push(PURE_ANNOTATION);
		push(`${helper(TO_DISPLAY_STRING)}(`);
		genNode(node.content, context);
		push(`)`);
	}
	// TODO
	function genCompoundExpression(node, context) {
		for (let i = 0; i < node.children.length; i++) {
			const child = node.children[i];
			if (isString(child)) {
				context.push(child);
			}
			else {
				genNode(child, context);
			}
		}
	}
	/**
	 * 生成表达式属性列表中的key值
	 */
	function genExpressionAsPropertyKey(node, context) {
		const { push } = context;
		if (node.type === 8 /* COMPOUND_EXPRESSION */) {
			push(`[`);
			genCompoundExpression(node, context);
			push(`]`);
		}
		else if (node.isStatic) {
			// only quote keys if necessary
			const text = isSimpleIdentifier(node.content)
				? node.content
				: JSON.stringify(node.content);
			push(text, node);
		}
		else {
			push(`[${node.content}]`, node);
		}
	}
	/**
	 * 生成注释代码
	 */
	function genComment(node, context) {
		{
			const { push, helper, pure } = context;
			if (pure) {
				push(PURE_ANNOTATION);
			}
			push(`${helper(CREATE_COMMENT)}(${JSON.stringify(node.content)})`, node);
		}
	}
	/**
	 * 生成VNode节点代码
	 */
	function genVNodeCall(node, context) {
		const { push, helper, pure } = context;
		const { tag, props, children, patchFlag, dynamicProps, directives, isBlock, disableTracking } = node;
		if (directives) {
			push(helper(WITH_DIRECTIVES) + `(`);
		}
		if (isBlock) {
			push(`(${helper(OPEN_BLOCK)}(${disableTracking ? `true` : ``}), `);
		}
		if (pure) {
			push(PURE_ANNOTATION);
		}
		push(helper(isBlock ? CREATE_BLOCK : CREATE_VNODE) + `(`, node);
		genNodeList(genNullableArgs([tag, props, children, patchFlag, dynamicProps]), context);
		push(`)`);
		if (isBlock) {
			push(`)`);
		}
		if (directives) {
			push(`, `);
			genNode(directives, context);
			push(`)`);
		}
	}
	/**
	 * 生成args代码
	 */
	function genNullableArgs(args) {
		let i = args.length;
		while (i--) {
			// 截取数组，去掉数组后面的空值，并将undefined转成 `null`
			if (args[i] != null)
				break;
		}
		return args.slice(0, i + 1).map(arg => arg || `null`);
	}
	// JavaScript
	function genCallExpression(node, context) {
		const { push, helper, pure } = context;
		const callee = isString(node.callee) ? node.callee : helper(node.callee);
		if (pure) {
			push(PURE_ANNOTATION);
		}
		push(callee + `(`, node);
		genNodeList(node.arguments, context);
		push(`)`);
	}
	/**
	 * 生成Object类型表达式代码
	 */
	function genObjectExpression(node, context) {
		const { push, indent, deindent, newline } = context;
		const { properties /* 属性列表 */} = node;
		if (!properties.length) {
			// 如果没有属性，则添加空对象代码，终止函数
			push(`{}`, node);
			return;
		}
		// 是否需要多行
		const multilines = properties.length > 1 ||
			(
				properties.some(p => p.value.type !== 4 /* SIMPLE_EXPRESSION */));
		// 添加代码开始符
		push(multilines ? `{` : `{ `);
		// 换行start
		multilines && indent();
		for (let i = 0; i < properties.length; i++) {
			const { key, value } = properties[i];
			// key
			genExpressionAsPropertyKey(key, context);
			push(`: `);
			// value
			genNode(value, context);
			if (i < properties.length - 1) {
				// will only reach this if it's multilines
				push(`,`);
				newline();
			}
		}
		// 换行end
		multilines && deindent();
		// 添加代码结束符
		push(multilines ? `}` : ` }`);
	}
	/**
	 * 生成数组表达式代码
	 */
	function genArrayExpression(node, context) {
		genNodeListAsArray(node.elements, context);
	}
	// TODO
	function genFunctionExpression(node, context) {
		const { push, indent, deindent, scopeId, mode } = context;
		const { params, returns, body, newline, isSlot } = node;
		if (isSlot) {
			push(`_${helperNameMap[WITH_CTX]}(`);
		}
		push(`(`, node);
		if (isArray(params)) {
			genNodeList(params, context);
		}
		else if (params) {
			genNode(params, context);
		}
		push(`) => `);
		if (newline || body) {
			push(`{`);
			indent();
		}
		if (returns) {
			if (newline) {
				push(`return `);
			}
			if (isArray(returns)) {
				genNodeListAsArray(returns, context);
			}
			else {
				genNode(returns, context);
			}
		}
		else if (body) {
			genNode(body, context);
		}
		if (newline || body) {
			deindent();
			push(`}`);
		}
		if (isSlot) {
			push(`)`);
		}
	}
	/**
	 * 生成条件表达式
	 * e.g. v-if/v-else/v-else-if
	 */
	function genConditionalExpression(node, context) {
		const { test, consequent, alternate, newline: needNewline } = node;
		const { push, indent, deindent, newline } = context;
		if (test.type === 4 /* SIMPLE_EXPRESSION */) {
			const needsParens = !isSimpleIdentifier(test.content);
			needsParens && push(`(`);
			genExpression(test, context);
			needsParens && push(`)`);
		}
		else {
			push(`(`);
			genNode(test, context);
			push(`)`);
		}
		needNewline && indent();
		context.indentLevel++;
		needNewline || push(` `);
		push(`? `);
		genNode(consequent, context);
		context.indentLevel--;
		needNewline && newline();
		needNewline || push(` `);
		push(`: `);
		const isNested = alternate.type === 19 /* JS_CONDITIONAL_EXPRESSION */;
		if (!isNested) {
			context.indentLevel++;
		}
		genNode(alternate, context);
		if (!isNested) {
			context.indentLevel--;
		}
		needNewline && deindent(true /* without newline */);
	}
	// TODO
	function genCacheExpression(node, context) {
		const { push, helper, indent, deindent, newline } = context;
		push(`_cache[${node.index}] || (`);
		if (node.isVNode) {
			indent();
			push(`${helper(SET_BLOCK_TRACKING)}(-1),`);
			newline();
		}
		push(`_cache[${node.index}] = `);
		genNode(node.value, context);
		if (node.isVNode) {
			push(`,`);
			newline();
			push(`${helper(SET_BLOCK_TRACKING)}(1),`);
			newline();
			push(`_cache[${node.index}]`);
			deindent();
		}
		push(`)`);
	}

	// 匹配JavaScript关键字
	const prohibitedKeywordRE = new RegExp('\\b' +
		('do,if,for,let,new,try,var,case,else,with,await,break,catch,class,const,' +
			'super,throw,while,yield,delete,export,import,return,switch,default,' +
			'extends,finally,continue,debugger,function,arguments,typeof,void')
			.split(',')
			.join('\\b|\\b') +
		'\\b');
	// 匹配JavaScript表达式中的字符串 e.g. '' "" ``
	const stripStringRE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*\$\{|\}(?:[^`\\]|\\.)*`|`(?:[^`\\]|\\.)*`/g;

	/**
	 * 校验JavaScript表达式是否正确
	 * @param {Object} node node节点
	 * @param {Object} context 上下文
	 * @param {Boolean} asParams 表达式是否作为参数来构建
	 * @param {Boolean} asRawStatements 是否为行内JavaScript声明语法
	 * @returns 
	 */
	function validateBrowserExpression(node, context, asParams = false, asRawStatements = false) {
		const exp = node.content;
		if (!exp.trim()) {
			return;
		}
		try {
			new Function(asRawStatements
				? ` ${exp} `
				: `return ${asParams ? `(${exp}) => {}` : `(${exp})`}`);
		}
		catch (e) {
			let message = e.message;
			const keywordMatch = exp
				.replace(stripStringRE, '')
				.match(prohibitedKeywordRE);
			if (keywordMatch) {
				// 避免使用JavaScript关键字作为属性名
				message = `avoid using JavaScript keyword as property name: "${keywordMatch[0]}"`;
			}
			// 创建处理JavaScript表达式错误
			context.onError(createCompilerError(43 /* X_INVALID_EXPRESSION */, node.loc, undefined, message));
		}
	}

	/**
	 * 转换表达式（traverseNode）
	 * @param {VNode} node node节点
	 * @param {Object} context 上下文
	 */
	const transformExpression = (node, context) => {
		if (node.type === 5 /* INTERPOLATION ------ 插值语法的文本 */) {
			node.content = processExpression(node.content, context);
		}
		else if (node.type === 1 /* ELEMENT */) {
			// 处理标签上的指令
			for (let i = 0; i < node.props.length; i++) {
				const dir = node.props[i];
				// 不用处理v-for和v-on，因为它们有专门的处理函数
				if (dir.type === 7 /* DIRECTIVE */ && dir.name !== 'for') {
					const exp = dir.exp;
					const arg = dir.arg;
					// 不用处理v-on:arg类型的指令，我们需要特别处理函数包裹它们
					if (exp &&
						exp.type === 4 /* SIMPLE_EXPRESSION */ &&
						!(dir.name === 'on' && arg)) {
						dir.exp = processExpression(exp, context,
							// slot的arguments必须处理成方法参数
							dir.name === 'slot');
					}
					// 处理arg
					if (arg && arg.type === 4 /* SIMPLE_EXPRESSION */ && !arg.isStatic) {
						dir.arg = processExpression(arg, context);
					}
				}
			}
		}
	};
	// 处理表达式
	function processExpression(node, context,
		// some expressions like v-slot props & v-for aliases should be parsed as
		// function params
		asParams = false,
		// v-on绑定的表达式可能包含复杂的声明
		asRawStatements = false) {
		{
			validateBrowserExpression(node, context, asParams, asRawStatements);
			return node;
		}
	}

	/**
	 * 转换结构指令v-if（traverseNode）
	 */
	const transformIf = createStructuralDirectiveTransform(/^(if|else|else-if)$/, (node, dir, context) => {
		return processIf(node, dir, context, (ifNode, branch, isRoot) => {
			const siblings = context.parent.children;
			let i = siblings.indexOf(ifNode);
			let key = 0;
			while (i-- >= 0) {
				const sibling = siblings[i];
				if (sibling && sibling.type === 9 /* IF */) {
					key += sibling.branches.length;
				}
			}
			// 返回一个回调 TODO
			return () => {
				if (isRoot) {
					ifNode.codegenNode = createCodegenNodeForBranch(branch, key, context);
				}
				else {
					// attach this branch's codegen node to the v-if root.
					const parentCondition = getParentCondition(ifNode.codegenNode);
					parentCondition.alternate = createCodegenNodeForBranch(branch, key + ifNode.branches.length - 1, context);
				}
			};
		});
	});
	// 处理v-if、v-else、v-else-if
	function processIf(node, dir, context, processCodegen) {
		if (dir.name !== 'else' &&
			(!dir.exp || !dir.exp.content.trim())) {
			const loc = dir.exp ? dir.exp.loc : node.loc;
			context.onError(createCompilerError(27 /* X_V_IF_NO_EXPRESSION */, dir.loc));
			// v-if没有表达式时，创建一个简单的表达式
			// e.g. v-if => v-if="true"
			dir.exp = createSimpleExpression(`true`, false, loc);
		}
		if (dir.exp) {
			// 表达式存在时，校验一下表达式
			validateBrowserExpression(dir.exp, context);
		}
		if (dir.name === 'if') {
			// 创建if分支
			const branch = createIfBranch(node, dir);
			const ifNode = {
				type: 9 /* IF */,
				loc: node.loc,
				branches: [branch]
			};
			context.replaceNode(ifNode);
			if (processCodegen) {
				// 执行回调
				return processCodegen(ifNode, branch, true);
			}
		}
		else {
			// locate the adjacent v-if
			const siblings = context.parent.children;
			const comments = [];
			let i = siblings.indexOf(node);
			while (i-- >= -1) {
				const sibling = siblings[i];
				if (sibling && sibling.type === 3 /* COMMENT */) {
					context.removeNode(sibling);
					comments.unshift(sibling);
					continue;
				}
				if (sibling &&
					sibling.type === 2 /* TEXT */ &&
					!sibling.content.trim().length) {
					context.removeNode(sibling);
					continue;
				}
				if (sibling && sibling.type === 9 /* IF */) {
					// move the node to the if node's branches
					context.removeNode();
					const branch = createIfBranch(node, dir);
					if (comments.length) {
						branch.children = [...comments, ...branch.children];
					}
					// check if user is forcing same key on different branches
					{
						const key = branch.userKey;
						if (key) {
							sibling.branches.forEach(({ userKey }) => {
								if (isSameKey(userKey, key)) {
									context.onError(createCompilerError(28 /* X_V_IF_SAME_KEY */, branch.userKey.loc));
								}
							});
						}
					}
					sibling.branches.push(branch);
					const onExit = processCodegen && processCodegen(sibling, branch, false);
					// since the branch was removed, it will not be traversed.
					// make sure to traverse here.
					traverseNode(branch, context);
					// call on exit
					if (onExit)
						onExit();
					// make sure to reset currentNode after traversal to indicate this
					// node has been removed.
					context.currentNode = null;
				}
				else {
					context.onError(createCompilerError(29 /* X_V_ELSE_NO_ADJACENT_IF */, node.loc));
				}
				break;
			}
		}
	}
	// 创建if分支对象
	function createIfBranch(node, dir) {
		return {
			type: 10 /* IF_BRANCH */,
			loc: node.loc,
			condition: dir.name === 'else' ? undefined : dir.exp,
			children: node.tagType === 3 /* TEMPLATE */ && !findDir(node, 'for')
				? node.children
				: [node],
			userKey: findProp(node, `key`)
		};
	}
	// TODO
	function createCodegenNodeForBranch(branch, keyIndex, context) {
		if (branch.condition) {
			return createConditionalExpression(branch.condition, createChildrenCodegenNode(branch, keyIndex, context),
				// make sure to pass in asBlock: true so that the comment node call
				// closes the current block.
				createCallExpression(context.helper(CREATE_COMMENT), [
					'"v-if"',
					'true'
				]));
		}
		else {
			return createChildrenCodegenNode(branch, keyIndex, context);
		}
	}
	// TODO
	function createChildrenCodegenNode(branch, keyIndex, context) {
		const { helper } = context;
		const keyProperty = createObjectProperty(`key`, createSimpleExpression(`${keyIndex}`, false, locStub, true));
		const { children } = branch;
		const firstChild = children[0];
		const needFragmentWrapper = children.length !== 1 || firstChild.type !== 1 /* ELEMENT */;
		if (needFragmentWrapper) {
			if (children.length === 1 && firstChild.type === 11 /* FOR */) {
				// optimize away nested fragments when child is a ForNode
				const vnodeCall = firstChild.codegenNode;
				injectProp(vnodeCall, keyProperty, context);
				return vnodeCall;
			}
			else {
				return createVNodeCall(context, helper(FRAGMENT), createObjectExpression([keyProperty]), children, `${64 /* STABLE_FRAGMENT */} /* ${PatchFlagNames[64 /* STABLE_FRAGMENT */]} */`, undefined, undefined, true, false, branch.loc);
			}
		}
		else {
			const vnodeCall = firstChild
				.codegenNode;
			// Change createVNode to createBlock.
			if (vnodeCall.type === 13 /* VNODE_CALL */) {
				vnodeCall.isBlock = true;
				helper(OPEN_BLOCK);
				helper(CREATE_BLOCK);
			}
			// inject branch key
			injectProp(vnodeCall, keyProperty, context);
			return vnodeCall;
		}
	}
	// 判断两个node节点的key值是否一致
	function isSameKey(a, b) {
		if (!a || a.type !== b.type) {
			return false;
		}
		if (a.type === 6 /* ATTRIBUTE */) {
			if (a.value.content !== b.value.content) {
				return false;
			}
		}
		else {
			// directive
			const exp = a.exp;
			const branchExp = b.exp;
			if (exp.type !== branchExp.type) {
				return false;
			}
			if (exp.type !== 4 /* SIMPLE_EXPRESSION */ ||
				(exp.isStatic !== branchExp.isStatic ||
					exp.content !== branchExp.content)) {
				return false;
			}
		}
		return true;
	}
	function getParentCondition(node) {
		while (true) {
			if (node.type === 19 /* JS_CONDITIONAL_EXPRESSION */) {
				if (node.alternate.type === 19 /* JS_CONDITIONAL_EXPRESSION */) {
					node = node.alternate;
				}
				else {
					return node;
				}
			}
			else if (node.type === 20 /* JS_CACHE_EXPRESSION */) {
				node = node.value;
			}
		}
	}

	// 转换结构指令v-for（traverseNode）
	const transformFor = createStructuralDirectiveTransform('for', (node, dir, context) => {
		const { helper } = context;
		return processFor(node, dir, context, forNode => {
			// 创建渲染列表表达式助手
			const renderExp = createCallExpression(helper(RENDER_LIST), [
				forNode.source
			]);
			const keyProp = findProp(node, `key`);
			const keyProperty = keyProp
				? createObjectProperty(`key`, keyProp.type === 6 /* ATTRIBUTE */
					? createSimpleExpression(keyProp.value.content, true)
					: keyProp.exp)
				: null;
			const isStableFragment = forNode.source.type === 4 /* SIMPLE_EXPRESSION */ &&
				forNode.source.isConstant;
			const fragmentFlag = isStableFragment
				? 64 /* STABLE_FRAGMENT */
				: keyProp
					? 128 /* KEYED_FRAGMENT */
					: 256 /* UNKEYED_FRAGMENT */;
			// 添加fragment助手函数
			forNode.codegenNode = createVNodeCall(context, helper(FRAGMENT), undefined, renderExp, `${fragmentFlag} /* ${PatchFlagNames[fragmentFlag]} */`, undefined, undefined, true /* isBlock */, !isStableFragment /* disableTracking */, node.loc);
			// TODO
			return () => {
				// finish the codegen now that all children have been traversed
				let childBlock;
				const isTemplate = isTemplateNode(node);
				const { children } = forNode;
				// check <template v-for> key placement
				if (isTemplate) {
					node.children.some(c => {
						if (c.type === 1 /* ELEMENT */) {
							const key = findProp(c, 'key');
							if (key) {
								context.onError(createCompilerError(32 /* X_V_FOR_TEMPLATE_KEY_PLACEMENT */, key.loc));
								return true;
							}
						}
					});
				}
				const needFragmentWrapper = children.length !== 1 || children[0].type !== 1 /* ELEMENT */;
				const slotOutlet = isSlotOutlet(node)
					? node
					: isTemplate &&
						node.children.length === 1 &&
						isSlotOutlet(node.children[0])
						? node.children[0] // api-extractor somehow fails to infer this
						: null;
				if (slotOutlet) {
					// <slot v-for="..."> or <template v-for="..."><slot/></template>
					childBlock = slotOutlet.codegenNode;
					if (isTemplate && keyProperty) {
						// <template v-for="..." :key="..."><slot/></template>
						// we need to inject the key to the renderSlot() call.
						// the props for renderSlot is passed as the 3rd argument.
						injectProp(childBlock, keyProperty, context);
					}
				}
				else if (needFragmentWrapper) {
					// <template v-for="..."> with text or multi-elements
					// should generate a fragment block for each loop
					childBlock = createVNodeCall(context, helper(FRAGMENT), keyProperty ? createObjectExpression([keyProperty]) : undefined, node.children, `${64 /* STABLE_FRAGMENT */} /* ${PatchFlagNames[64 /* STABLE_FRAGMENT */]} */`, undefined, undefined, true);
				}
				else {
					// Normal element v-for. Directly use the child's codegenNode
					// but mark it as a block.
					childBlock = children[0]
						.codegenNode;
					if (isTemplate && keyProperty) {
						injectProp(childBlock, keyProperty, context);
					}
					childBlock.isBlock = !isStableFragment;
					if (childBlock.isBlock) {
						helper(OPEN_BLOCK);
						helper(CREATE_BLOCK);
					}
				}
				renderExp.arguments.push(createFunctionExpression(createForLoopParams(forNode.parseResult), childBlock, true /* force newline */));
			};
		});
	});
	/**
	 * 处理v-for指令
	 * @param {VNode} node node节点
	 * @param {Object} dir 结构指令
	 * @param {Object} context 上下文
	 * @param {Function} processCodegen 处理编码函数 
	 * @returns 
	 */
	function processFor(node, dir, context, processCodegen) {
		if (!dir.exp) {
			// v-for没有绑定表达式
			context.onError(createCompilerError(30 /* X_V_FOR_NO_EXPRESSION */, dir.loc));
			return;
		}
		// 只能是简单的表达式，因为在vFor转换之前应用表达式转换过了
		const parseResult = parseForExpression(
			dir.exp, context);
		if (!parseResult) {
			context.onError(createCompilerError(31 /* X_V_FOR_MALFORMED_EXPRESSION */, dir.loc));
			return;
		}
		const { addIdentifiers, removeIdentifiers, scopes } = context;
		const { source, value, key, index } = parseResult;
		const forNode = {
			type: 11 /* FOR */,
			loc: dir.loc,
			source,
			valueAlias: value,
			keyAlias: key,
			objectIndexAlias: index,
			parseResult,
			children: isTemplateNode(node) ? node.children : [node]
		};
		context.replaceNode(forNode);
		// 添加vFor标识
		scopes.vFor++;
		// 执行回调
		const onExit = processCodegen && processCodegen(forNode);
		return () => {
			// 移除当前节点的vFor标识
			scopes.vFor--;
			if (onExit)
				onExit();
		};
	}

	// e.g. v-for="item in list"
	// 匹配v-for别名
	const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/;
	// 匹配v-for迭代器
	const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/;
	// 匹配`()`
	const stripParensRE = /^\(|\)$/g;
	// 解析v-for表达式
	function parseForExpression(input, context) {
		const loc = input.loc;
		const exp = input.content;
		const inMatch = exp.match(forAliasRE);
		if (!inMatch)
			return;
		const [, LHS, RHS] = inMatch;
		const result = {
			source: createAliasExpression(loc, RHS.trim(), exp.indexOf(RHS, LHS.length)),
			value: undefined,
			key: undefined,
			index: undefined
		};
		{
			validateBrowserExpression(result.source, context);
		}
		let valueContent = LHS.trim()
			.replace(stripParensRE, '') // e.g. "(item, index)" => "item, index"
			.trim();
		const trimmedOffset = LHS.indexOf(valueContent);
		const iteratorMatch = valueContent.match(forIteratorRE);
		// 匹配 `,`
		if (iteratorMatch) {
			// e.g. "item, index" => "item"
			valueContent = valueContent.replace(forIteratorRE, '').trim(); // item
			const keyContent = iteratorMatch[1].trim(); // index
			let keyOffset;
			if (keyContent) {
				// index的索引
				keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length);
				result.key = createAliasExpression(loc, keyContent, keyOffset);
				{
					validateBrowserExpression(result.key, context, true);
				}
			}
			if (iteratorMatch[2]) {
				// e.g. exp = '(value, name, index) in object'
				// valueContent = 'value'
				// keyContent = 'name'
				// indexContent = 'index'
				const indexContent = iteratorMatch[2].trim();
				if (indexContent) {
					result.index = createAliasExpression(loc, indexContent, exp.indexOf(indexContent, result.key
						? keyOffset + keyContent.length
						: trimmedOffset + valueContent.length));
					{
						validateBrowserExpression(result.index, context, true);
					}
				}
			}
		}
		// 默认有value
		if (valueContent) {
			result.value = createAliasExpression(loc, valueContent, trimmedOffset);
			{
				validateBrowserExpression(result.value, context, true);
			}
		}
		return result;
	}

	// 创建别名表达式
	function createAliasExpression(range, content, offset) {
		return createSimpleExpression(content, false, getInnerRange(range, offset, content.length));
	}
	// 创建循环参数
	function createForLoopParams({ value, key, index }) {
		const params = [];
		if (value) {
			params.push(value);
		}
		if (key) {
			if (!value) {
				params.push(createSimpleExpression(`_`, false));
			}
			params.push(key);
		}
		if (index) {
			if (!key) {
				if (!value) {
					params.push(createSimpleExpression(`_`, false));
				}
				params.push(createSimpleExpression(`__`, false));
			}
			params.push(index);
		}
		return params;
	}

	const defaultFallback = createSimpleExpression(`undefined`, false);
	/**
	 * 跟踪作用域插槽的作用域标识符，以便它们不带前缀。（traverseNode）
	 * @param {VNode} node node节点
	 * @param {Object} context 上下文
	 */
	const trackSlotScopes = (node, context) => {
		if (node.type === 1 /* ELEMENT */ &&
			(node.tagType === 1 /* COMPONENT */ ||
				node.tagType === 3 /* TEMPLATE */)) {
			// 我们在这里只检查非空v-slot
			// 因为我们只关心引入作用域变量的插槽
			const vSlot = findDir(node, 'slot');
			if (vSlot) {
				const slotProps = vSlot.exp;
				context.scopes.vSlot++;
				return () => {
					// 返回一个回调，清掉当前层级的slot scope
					context.scopes.vSlot--;
				};
			}
		}
	};
	// 构建子元素的插槽内容
	const buildClientSlotFn = (props, children, loc) => createFunctionExpression(props, children, false /* newline */, true /* isSlot */, children.length ? children[0].loc : loc);
	// 构建slots
	function buildSlots(node, context, buildSlotFn = buildClientSlotFn) {
		context.helper(WITH_CTX); // 添加助手函数withCtx
		const { children, loc } = node;
		const slotsProperties = [];
		const dynamicSlots = [];
		const buildDefaultSlotProperty = (props, children) => createObjectProperty(`default`, buildSlotFn(props, children, loc));
		// 是否有动态的插槽内容 e.g. v-for、作用域插槽
		let hasDynamicSlots = context.scopes.vSlot > 0 || context.scopes.vFor > 0;
		// 1. 检查v-slot在组件上
		//    <Comp v-slot="{ prop }"/>
		const onComponentSlot = findDir(node, 'slot', true);
		if (onComponentSlot) {
			const { arg /* 参数 */, exp } = onComponentSlot;
			// 如果arg存在且为动态的 e.g. <Comp v-slot:[dynamicSlotName]="{ prop }" />
			if (arg && !isStaticExp(arg)) {
				hasDynamicSlots = true;
			}
			slotsProperties.push(createObjectProperty(arg || createSimpleExpression('default', true), buildSlotFn(exp, children, loc)));
		}
		// 2. 迭代子元素检查template slots
		//    e.g. <template v-slot:foo=“{ prop }">
		let hasTemplateSlots = false;
		let hasNamedDefaultSlot = false;
		const implicitDefaultChildren = []; // 存储隐式的默认插槽
		const seenSlotNames = new Set();
		for (let i = 0; i < children.length; i++) {
			const slotElement = children[i];
			let slotDir;
			if (!isTemplateNode(slotElement) ||
				!(slotDir = findDir(slotElement, 'slot', true))) {
				// 不是 <template v-slot>, 跳过该节点
				if (slotElement.type !== 3 /* COMMENT */) {
					implicitDefaultChildren.push(slotElement);
				}
				continue;
			}
			if (onComponentSlot) {
				// 已经在组件标签上使用了v-slot - 这是一种错误的使用方式
				// e.g. 
				// <child v-slot="{ prop }">
				// 	<template v-slot:[dynamicSlotName]>Here might be a page title</template>
				// </child>
				context.onError(createCompilerError(36 /* X_V_SLOT_MIXED_SLOT_USAGE */, slotDir.loc));
				break;
			}
			hasTemplateSlots = true;
			const { children: slotChildren, loc: slotLoc } = slotElement;
			const { arg: slotName = createSimpleExpression(`default`, true), exp: slotProps, loc: dirLoc } = slotDir;
			// 检查名称是否为静态的
			let staticSlotName;
			if (isStaticExp(slotName)) {
				staticSlotName = slotName ? slotName.content : `default`;
			}
			else {
				hasDynamicSlots = true;
			}
			const slotFunction = buildSlotFn(slotProps, slotChildren, slotLoc);
			// 检查slot是否有条件判断 (v-if/v-for)
			let vIf;
			let vElse;
			let vFor;
			// v-if
			if ((vIf = findDir(slotElement, 'if'))) {
				hasDynamicSlots = true;
				dynamicSlots.push(createConditionalExpression(vIf.exp, buildDynamicSlot(slotName, slotFunction), defaultFallback));
			}
			// v-else / v-else-if
			else if ((vElse = findDir(slotElement, /^else(-if)?$/, true /* allowEmpty */))) {
				let j = i;
				let prev;
				while (j--) {
					prev = children[j];
					if (prev.type !== 3 /* COMMENT */) {
						break;
					}
				}
				if (prev && isTemplateNode(prev) && findDir(prev, 'if')) {
					// 移除前一个节点node
					children.splice(i, 1);
					i--;
					// 将这个插槽附加到前面的条件中
					let conditional = dynamicSlots[dynamicSlots.length - 1];
					while (conditional.alternate.type === 19 /* JS_CONDITIONAL_EXPRESSION */) {
						conditional = conditional.alternate;
					}
					conditional.alternate = vElse.exp
						? createConditionalExpression(vElse.exp, buildDynamicSlot(slotName, slotFunction), defaultFallback)
						: buildDynamicSlot(slotName, slotFunction);
				}
				else {
					context.onError(createCompilerError(29 /* X_V_ELSE_NO_ADJACENT_IF */, vElse.loc));
				}
			}
			// v-for
			else if ((vFor = findDir(slotElement, 'for'))) {
				hasDynamicSlots = true;
				const parseResult = vFor.parseResult ||
					parseForExpression(vFor.exp, context);
				if (parseResult) {
					// 添加助手函数renderList
					dynamicSlots.push(createCallExpression(context.helper(RENDER_LIST), [
						parseResult.source,
						createFunctionExpression(createForLoopParams(parseResult), buildDynamicSlot(slotName, slotFunction), true /* force newline */)
					]));
				}
				else {
					// 无效v-for表达式
					context.onError(createCompilerError(31 /* X_V_FOR_MALFORMED_EXPRESSION */, vFor.loc));
				}
			}
			else {
				// 校验重复的静态名称
				if (staticSlotName) {
					if (seenSlotNames.has(staticSlotName)) {
						context.onError(createCompilerError(37 /* X_V_SLOT_DUPLICATE_SLOT_NAMES */, dirLoc));
						continue;
					}
					seenSlotNames.add(staticSlotName);
					if (staticSlotName === 'default') {
						// 默认的插槽名称
						hasNamedDefaultSlot = true;
					}
				}
				slotsProperties.push(createObjectProperty(slotName, slotFunction));
			}
		}
		if (!onComponentSlot) {
			if (!hasTemplateSlots) {
				// 隐式的默认插槽
				slotsProperties.push(buildDefaultSlotProperty(undefined, children));
			}
			else if (implicitDefaultChildren.length) {
				if (hasNamedDefaultSlot /* template含有默认的插槽名称 */) {
					context.onError(createCompilerError(38 /* X_V_SLOT_EXTRANEOUS_DEFAULT_SLOT_CHILDREN */, implicitDefaultChildren[0].loc));
				}
				else {
					slotsProperties.push(buildDefaultSlotProperty(undefined, implicitDefaultChildren));
				}
			}
		}
		const slotFlag = hasDynamicSlots
			? 2 /* DYNAMIC 动态的 */
			: hasForwardedSlots(node.children)
				? 3 /* FORWARDED 深层的 */
				: 1 /* STABLE 固定的 */;
		// 创建插槽内容（对象表达式）
		let slots = createObjectExpression(slotsProperties.concat(createObjectProperty(`_`,
			// 2 = 编译动态的 = 可以跳过格式化，但是必须进行diff算法
			// 1 = 编译静态的 = 在进行patch时可以跳过格式化和diff算法
			createSimpleExpression('' + slotFlag, false))), loc);
		if (dynamicSlots.length) {
			slots = createCallExpression(context.helper(CREATE_SLOTS), [
				slots,
				createArrayExpression(dynamicSlots)
			]);
		}
		return {
			slots,
			hasDynamicSlots
		};
	}
	// 构建动态slot
	function buildDynamicSlot(name, fn) {
		return createObjectExpression([
			createObjectProperty(`name`, name),
			createObjectProperty(`fn`, fn)
		]);
	}
	// 拥有深层的slots（即子元素也有slots）
	function hasForwardedSlots(children) {
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (child.type === 1 /* ELEMENT */) {
				if (child.tagType === 2 /* SLOT */ ||
					(child.tagType === 0 /* ELEMENT */ &&
						hasForwardedSlots(child.children))) {
					return true;
				}
			}
		}
		return false;
	}

	const directiveImportMap = new WeakMap();
	/**
	 * 转换Element元素（traverseNode）
	 */
	const transformElement = (node, context) => {
		if (!(node.type === 1 /* ELEMENT */ &&
			(node.tagType === 0 /* ELEMENT */ ||
				node.tagType === 1 /* COMPONENT */))) {
			return;
		}
		// 在所有子表达式被处理和合并后，执行退出操作
		return function postTransformElement() {
			const { tag, props } = node;
			const isComponent = node.tagType === 1 /* COMPONENT */;
			// e.g. '_component_child'
			const vnodeTag = isComponent
				? resolveComponentType(node, context)
				: `"${tag}"`;
			// 是否为动态解析组价
			const isDynamicComponent = isObject(vnodeTag) && vnodeTag.callee === RESOLVE_DYNAMIC_COMPONENT;
			let vnodeProps;
			let vnodeChildren;
			let vnodePatchFlag;
			let patchFlag = 0;
			let vnodeDynamicProps;
			let dynamicPropNames;
			let vnodeDirectives;
			let shouldUseBlock =
				// 动态组件可以解析为普通元素
				/*
					e.g. 
					有些元素，像：
					<ul>
						<li></li>
					</ul>
					// 不能这样用
					<ul>
						<child></child>
					</ul>

					这样就不能复用child这个组件了，如果要达到我们的目的，我们就要用js特性：
					<ul>
						<li is="child"></li>
					</ul>
				*/
				isDynamicComponent ||
				vnodeTag === TELEPORT ||
				vnodeTag === SUSPENSE ||
				(!isComponent &&
					// svg和foreignObject必须强制放入块中
					(tag === 'svg' ||
						tag === 'foreignObject' ||
						findProp(node, 'key', true)));
			// 解析组件的props
			if (props.length > 0) {
				const propsBuildResult = buildProps(node, context);
				vnodeProps = propsBuildResult.props;
				patchFlag = propsBuildResult.patchFlag;
				dynamicPropNames = propsBuildResult.dynamicPropNames;
				const directives = propsBuildResult.directives;
				vnodeDirectives =
					directives && directives.length
						? createArrayExpression(directives.map(dir => buildDirectiveArgs(dir, context)))
						: undefined;
			}
			// children
			if (node.children.length > 0) {
				if (vnodeTag === KEEP_ALIVE) {
					// Although a built-in component, we compile KeepAlive with raw children
					// instead of slot functions so that it can be used inside Transition
					// or other Transition-wrapping HOCs.
					// To ensure correct updates with block optimizations, we need to:
					// 1. Force keep-alive into a block. This avoids its children being
					//    collected by a parent block.
					shouldUseBlock = true;
					// 2. Force keep-alive to always be updated, since it uses raw children.
					patchFlag |= 1024 /* DYNAMIC_SLOTS */;
					if (node.children.length > 1) {
						context.onError(createCompilerError(44 /* X_KEEP_ALIVE_INVALID_CHILDREN */, {
							start: node.children[0].loc.start,
							end: node.children[node.children.length - 1].loc.end,
							source: ''
						}));
					}
				}
				// 是否需要构建slots
				const shouldBuildAsSlots = isComponent &&
					// Teleport is not a real component and has dedicated runtime handling
					vnodeTag !== TELEPORT &&
					// explained above.
					vnodeTag !== KEEP_ALIVE;
				if (shouldBuildAsSlots) {
					const { slots, hasDynamicSlots } = buildSlots(node, context);
					vnodeChildren = slots;
					if (hasDynamicSlots) {
						patchFlag |= 1024 /* DYNAMIC_SLOTS */;
					}
				}
				else if (node.children.length === 1 && vnodeTag !== TELEPORT) {
					const child = node.children[0];
					const type = child.type;
					// check for dynamic text children
					const hasDynamicTextChild = type === 5 /* INTERPOLATION */ ||
						type === 8 /* COMPOUND_EXPRESSION */;
					if (hasDynamicTextChild && !getStaticType(child)) {
						patchFlag |= 1 /* TEXT */;
					}
					// pass directly if the only child is a text node
					// (plain / interpolation / expression)
					if (hasDynamicTextChild || type === 2 /* TEXT */) {
						vnodeChildren = child;
					}
					else {
						vnodeChildren = node.children;
					}
				}
				else {
					vnodeChildren = node.children;
				}
			}
			// patchFlag & dynamicPropNames
			if (patchFlag !== 0) {
				{
					if (patchFlag < 0) {
						// special flags (negative and mutually exclusive)
						vnodePatchFlag = patchFlag + ` /* ${PatchFlagNames[patchFlag]} */`;
					}
					else {
						// bitwise flags
						const flagNames = Object.keys(PatchFlagNames)
							.map(Number)
							.filter(n => n > 0 && patchFlag & n)
							.map(n => PatchFlagNames[n])
							.join(`, `);
						vnodePatchFlag = patchFlag + ` /* ${flagNames} */`;
					}
				}
				if (dynamicPropNames && dynamicPropNames.length) {
					vnodeDynamicProps = stringifyDynamicPropNames(dynamicPropNames);
				}
			}
			node.codegenNode = createVNodeCall(context, vnodeTag, vnodeProps, vnodeChildren, vnodePatchFlag, vnodeDynamicProps, vnodeDirectives, !!shouldUseBlock, false /* disableTracking */, node.loc);
		};
	};
	// 解析组件类型
	function resolveComponentType(node, context, ssr = false) {
		const { tag } = node;
		// 1. 动态的组件 e.g. <component is="child"></component> <ul><li v-is="child"></li></ul>
		const isProp = node.tag === 'component' ? findProp(node, 'is') : findDir(node, 'is');
		if (isProp) {
			const exp = isProp.type === 6 /* ATTRIBUTE */
				? isProp.value && createSimpleExpression(isProp.value.content, true)
				: isProp.exp;
			if (exp) {
				return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
					exp
				]);
			}
		}
		// 2. 内置组件 (components (Teleport, Transition, KeepAlive, Suspense...)
		const builtIn = isCoreComponent(tag) || context.isBuiltInComponent(tag);
		if (builtIn) {
			// 返回内置组件
			if (!ssr)
				context.helper(builtIn);
			return builtIn;
		}
		// 3. user component (from setup bindings)
		if (context.bindingMetadata[tag] === 'setup') {
			return `$setup[${JSON.stringify(tag)}]`;
		}
		// 4. 程序员定义的组件 e.g. <child></child>
		context.helper(RESOLVE_COMPONENT);
		context.components.add(tag);
		return toValidAssetId(tag, `component`);
	}
	// 构建props
	function buildProps(node, context, props = node.props, ssr = false) {
		const { tag, loc: elementLoc } = node;
		const isComponent = node.tagType === 1 /* COMPONENT */;
		let properties = [];
		const mergeArgs = [];
		const runtimeDirectives = [];
		let patchFlag = 0;
		let hasRef = false;
		let hasClassBinding = false;
		let hasStyleBinding = false;
		let hasHydrationEventBinding = false; /* 具有水合（服务端渲染）事件绑定 */
		let hasDynamicKeys = false; /* 具有动态的属性名 */
		let hasVnodeHook = false; /* 具有保留hook属性 */
		const dynamicPropNames = [];
		
		// 分析补丁标志
		const analyzePatchFlag = ({ key, value }) => {
			if (isStaticExp(key)) {
				const name = key.content;
				const isEventHandler = isOn(name);
				if (!isComponent &&
					isEventHandler &&
					name.toLowerCase() !== 'onclick' &&
					name !== 'onUpdate:modelValue' &&
					!isReservedProp(name)) {
					// 不是组件且属性名有on开头且name转小写后不能等于onclick且name不能为v-model，且name不能为保留属性名
					hasHydrationEventBinding = true;
				}
				if (isEventHandler && isReservedProp(name)) {
					hasVnodeHook = true;
				}
				if (value.type === 20 /* JS_CACHE_EXPRESSION */ ||
					((value.type === 4 /* SIMPLE_EXPRESSION */ ||
						value.type === 8 /* COMPOUND_EXPRESSION */) &&
						getStaticType(value) > 0)) {
					// 跳过常量或者cacheHandlers修饰器的属性
					return;
				}
				if (name === 'ref' /* 属性名为ref */) {
					hasRef = true;
				}
				else if (name === 'class' && !isComponent /* 不是组件，可以绑定class */) {
					hasClassBinding = true;
				}
				else if (name === 'style' && !isComponent /* 不是组件，可以绑定style */) {
					hasStyleBinding = true;
				}
				else if (name !== 'key' && !dynamicPropNames.includes(name)) {
					// name不为key且动态属性数组中没有添加过该属性，则加入动态属性数组中
					dynamicPropNames.push(name);
				}
			}
			else {
				hasDynamicKeys = true;
			}
		};
		for (let i = 0; i < props.length; i++) {
			const prop = props[i];
			if (prop.type === 6 /* ATTRIBUTE */) {
				// 解析动态属性
				const { loc, name, value } = prop;
				if (name === 'ref') {
					hasRef = true;
				}
				// 跳过 :is on <component>
				if (name === 'is' && tag === 'component') {
					continue;
				}
				properties.push(createObjectProperty(createSimpleExpression(name, true, getInnerRange(loc, 0, name.length)), createSimpleExpression(value ? value.content : '', true, value ? value.loc : loc)));
			}
			else {
				// 指令形式属性 e.g. v-bind v-on
				const { name, arg, exp, loc } = prop;
				const isBind = name === 'bind';
				const isOn = name === 'on';
				// 跳过v-slot - 它由它的专用转换器来处理
				if (name === 'slot') {
					if (!isComponent) {
						// v-slot只能用在组件或者template标签上
						context.onError(createCompilerError(39 /* X_V_SLOT_MISPLACED */, loc));
					}
					continue;
				}
				// 跳过 v-once - 它由它的专用转换器来处理
				if (name === 'once') {
					continue;
				}
				// 跳过 v-is and :is on <component>
				// e.g.
				// <ul><li v-is="child"></li></ul> <component :is="otherComponent"></component>
				if (name === 'is' ||
					(isBind && tag === 'component' && isBindKey(arg, 'is'))) {
					continue;
				}
				// 跳过 v-on在ssr渲染环境下
				if (isOn && ssr) {
					continue;
				}
				// 对于v-bind和v-on没有argument的
				// e.g. v-bind="flag" v-on="obj"
				if (!arg && (isBind || isOn)) {
					hasDynamicKeys = true;
					if (exp) {
						if (properties.length) {
							mergeArgs.push(createObjectExpression(dedupeProperties(properties), elementLoc));
							properties = [];
						}
						if (isBind) {
							mergeArgs.push(exp);
						}
						else {
							// v-on="obj" -> toHandlers(obj)
							mergeArgs.push({
								type: 14 /* JS_CALL_EXPRESSION */,
								loc,
								callee: context.helper(TO_HANDLERS),
								arguments: [exp]
							});
						}
					}
					else {
						// v-bind 或者 v-on没有绑定表达式，报错
						context.onError(createCompilerError(isBind
							? 33 /* X_V_BIND_NO_EXPRESSION */
							: 34 /* X_V_ON_NO_EXPRESSION */, loc));
					}
					continue;
				}
				// 根据名称调用transform转换函数
				const directiveTransform = context.directiveTransforms[name];
				if (directiveTransform) {
					// needRuntime => V_MODEL_TEXT、V_SHOW
					const { props, needRuntime } = directiveTransform(prop, node, context);
					!ssr && props.forEach(analyzePatchFlag);
					properties.push(...props);
					if (needRuntime) {
						runtimeDirectives.push(prop);
						if (isSymbol(needRuntime)) {
							// TODO 这个map存放的东西拿来干嘛
							directiveImportMap.set(prop, needRuntime);
						}
					}
				}
				else {
					// 用户自定义转换函数（包括v-show，v-model（type为text类型））
					runtimeDirectives.push(prop);
				}
			}
		}
		let propsExpression = undefined;
		// 含有 v-bind="object" 或者v-on="object"
		if (mergeArgs.length) {
			if (properties.length) {
				mergeArgs.push(createObjectExpression(dedupeProperties(properties), elementLoc));
			}
			if (mergeArgs.length > 1) {
				// 有普通属性和v-bind="object"或者v-on="object"，调用mergeProps助手函数
				propsExpression = createCallExpression(context.helper(MERGE_PROPS), mergeArgs, elementLoc);
			}
			else {
				// 单一的v-bind="object"或者单一的v-on="object"，不需要使用mergeProps助手函数
				propsExpression = mergeArgs[0];
			}
		}
		else if (properties.length) {
			propsExpression = createObjectExpression(dedupeProperties(properties), elementLoc);
		}
		if (hasDynamicKeys) {
			patchFlag |= 16 /* FULL_PROPS */;
		}
		else {
			if (hasClassBinding) {
				patchFlag |= 2 /* CLASS */;
			}
			if (hasStyleBinding) {
				patchFlag |= 4 /* STYLE */;
			}
			if (dynamicPropNames.length) {
				patchFlag |= 8 /* PROPS */;
			}
			if (hasHydrationEventBinding) {
				patchFlag |= 32 /* HYDRATE_EVENTS */;
			}
		}
		if ((patchFlag === 0 || patchFlag === 32 /* HYDRATE_EVENTS */) &&
			(hasRef || hasVnodeHook || runtimeDirectives.length > 0)) {
			// 每次更新，都需要patch
			patchFlag |= 512 /* NEED_PATCH */;
		}
		return {
			props: propsExpression,
			directives: runtimeDirectives,
			patchFlag,
			dynamicPropNames
		};
	}
	// 取出重复属性，对于属性名等于style、class或者属性名以on开头的属性，采用合并的方式
	function dedupeProperties(properties) {
		const knownProps = new Map();
		const deduped = [];
		for (let i = 0; i < properties.length; i++) {
			const prop = properties[i];
			// 对于动态的属性名或者组件类型的属性，总是添加到属性数组中
			if (prop.key.type === 8 /* COMPOUND_EXPRESSION */ || !prop.key.isStatic) {
				deduped.push(prop);
				continue;
			}
			const name = prop.key.content;
			const existing = knownProps.get(name);
			if (existing) {
				// e.g. <div :style="{width: '10px'}" style="height: 100px"></div>
				if (name === 'style' || name === 'class' || name.startsWith('on')) {
					mergeAsArray(existing, prop);
				}
			}
			else {
				knownProps.set(name, prop);
				deduped.push(prop);
			}
		}
		return deduped;
	}
	// 将两个对象集合合成数组（数组形式表达式对象）
	function mergeAsArray(existing, incoming) {
		if (existing.value.type === 17 /* JS_ARRAY_EXPRESSION */) {
			existing.value.elements.push(incoming.value);
		}
		else {
			existing.value = createArrayExpression([existing.value, incoming.value], existing.loc);
		}
	}
	// 构建自定义指令arguments
	function buildDirectiveArgs(dir, context) {
		const dirArgs = [];
		const runtime = directiveImportMap.get(dir);
		if (runtime) {
			// TODO
			dirArgs.push(context.helperString(runtime));
		}
		else {
			// 添加助手函数 resolveDirective解析指令
			context.helper(RESOLVE_DIRECTIVE);
			// 添加自定义指令名称 set集合，去除重复
			context.directives.add(dir.name);
			dirArgs.push(toValidAssetId(dir.name, `directive`));
		}

		// e.g. 
		// <div v-demo:hello.a.b="message"></div>
		// new Vue({ el: '#app', data: { message: 'hello!' } })
		const { loc } = dir;
		if (dir.exp)
			dirArgs.push(dir.exp); // 添加表达式 'message'
		if (dir.arg) {
			if (!dir.exp) {
				dirArgs.push(`void 0`);
			}
			dirArgs.push(dir.arg); // 添加arguments 'hello'
		}
		if (Object.keys(dir.modifiers).length) {
			if (!dir.arg) {
				if (!dir.exp) {
					dirArgs.push(`void 0`);
				}
				dirArgs.push(`void 0`);
			}
			// 创建content为true的简易表达式
			const trueExpression = createSimpleExpression(`true`, false, loc);
			dirArgs.push(createObjectExpression(dir.modifiers.map(modifier => createObjectProperty(modifier, trueExpression)), loc));
		}
		return createArrayExpression(dirArgs, dir.loc);
	}

	// 将v-bind绑定的属性名转成JSON字符串
	// e.g. <div v-bind:name="fanqiewa" v-bind:age="18"></div>
	// return '["name", "age"]'
	function stringifyDynamicPropNames(props) {
		let propsNamesString = `[`;
		for (let i = 0, l = props.length; i < l; i++) {
			propsNamesString += JSON.stringify(props[i]);
			if (i < l - 1)
				propsNamesString += ', ';
		}
		return propsNamesString + `]`;
	}

	/**
	 * 转换插槽出口节点<slot></slot>（traverseNode）
	 */
	const transformSlotOutlet = (node, context) => {
		if (isSlotOutlet(node)) {
			const { children, loc } = node;
			const { slotName, slotProps /* 插槽属性（作用域插槽） */ } = processSlotOutlet(node, context);
			const slotArgs = [
				context.prefixIdentifiers ? `_ctx.$slots` : `$slots`,
				slotName
			];
			if (slotProps) {
				slotArgs.push(slotProps);
			}
			if (children.length) {
				if (!slotProps) {
					slotArgs.push(`{}`);
				}
				slotArgs.push(createFunctionExpression([], children, false, false, loc));
			}
			node.codegenNode = createCallExpression(context.helper(RENDER_SLOT), slotArgs, loc);
		}
	};
	// 处理slot插槽语法的出口（outlet）
	function processSlotOutlet(node, context) {
		let slotName = `"default"`;
		let slotProps = undefined;
		// check for <slot name="xxx" OR :name="xxx" />
		const name = findProp(node, 'name');
		if (name) {
			if (name.type === 6 /* ATTRIBUTE */ && name.value) {
				// 静态绑定 name
				slotName = JSON.stringify(name.value.content);
			}
			else if (name.type === 7 /* DIRECTIVE */ && name.exp) {
				// 动态绑定 name
				slotName = name.exp;
			}
		}
		const propsWithoutName = name
			? node.props.filter(p => p !== name)
			: node.props;
		if (propsWithoutName.length > 0) {
			const { props, directives } = buildProps(node, context, propsWithoutName);
			slotProps = props;
			if (directives.length) {
				// <slot></slot> 不支持自定义指令
				context.onError(createCompilerError(35 /* X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET */, directives[0].loc));
			}
		}
		return {
			slotName,
			slotProps
		};
	}

	// 匹配函数表达式
	const fnExpRE = /^\s*([\w$_]+|\([^)]*?\))\s*=>|^\s*function(?:\s+[\w$]+)?\s*\(/;
	// 转换v-on指令
	const transformOn = (dir, node, context, augmentor) => {
		const { loc, modifiers, arg } = dir;
		if (!dir.exp && !modifiers.length) {
			// TODO 什么情况下会进入此判断
			// v-on缺少表达式（绑定值）
			context.onError(createCompilerError(34 /* X_V_ON_NO_EXPRESSION */, loc));
		}
		let eventName;
		if (arg.type === 4 /* SIMPLE_EXPRESSION */) {
			if (arg.isStatic) {
				const rawName = arg.content;
				// 创建简单的表达式，调用toHandlerKey添加on前缀
				eventName = createSimpleExpression(toHandlerKey(camelize(rawName)), true, arg.loc);
			}
			else {
				// 动态绑定 e.g. v-on:[event]
				eventName = createCompoundExpression([
					`${context.helperString(TO_HANDLER_KEY)}(`,
					arg,
					`)`
				]);
			}
		}
		else {
			// TODO 什么情况下进入此判断
			// 动态的，并且已经处理过的
			eventName = arg;
			eventName.children.unshift(`${context.helperString(TO_HANDLER_KEY)}(`);
			eventName.children.push(`)`);
		}
		let exp = dir.exp;
		if (exp && !exp.content.trim()) {
			exp = undefined;
		}
		let isCacheable = context.cacheHandlers && !exp;
		if (exp) {
			const isMemberExp = isMemberExpression(exp.content);
			const isInlineStatement = !(isMemberExp || fnExpRE.test(exp.content));
			const hasMultipleStatements = exp.content.includes(`;`);
			{
				validateBrowserExpression(exp, context, false, hasMultipleStatements);
			}
			if (isInlineStatement || (isCacheable && isMemberExp)) {
				// 使用一个function来包裹行间声明语法
				exp = createCompoundExpression([
					`${isInlineStatement ? `$event` : `(...args)`} => ${hasMultipleStatements ? `{` : `(`}`,
					exp,
					hasMultipleStatements ? `}` : `)`
				]);
			}
		}
		let ret = {
			props: [
				createObjectProperty(eventName, exp || createSimpleExpression(`() => {}`, false, loc))
			]
		};
		if (augmentor) {
			// 执行回调
			ret = augmentor(ret);
		}
		if (isCacheable) {
			// 使用缓存函数将已经编译过的值缓存下来，以便它总是在处理相同的程序时被传递下去。
			// 避免组件不需要重新渲染时，用户在组件上使用的行内JavaScript声明语法重复渲染
			ret.props[0].value = context.cache(ret.props[0].value);
		}
		return ret;
	};

	// 转换v-bind指令
	const transformBind = (dir, node, context) => {
		const { exp, modifiers, loc } = dir;
		const arg = dir.arg;
		if (arg.type !== 4 /* SIMPLE_EXPRESSION */) {
			// TODO 无法进入此判断
			arg.children.unshift(`(`);
			arg.children.push(`) || ""`);
		}
		else if (!arg.isStatic) {
			// 动态绑定 e.g. :[name].camel="count"
			arg.content = `${arg.content} || ""`;
		}
		// .camel
		if (modifiers.includes('camel')) {
			if (arg.type === 4 /* SIMPLE_EXPRESSION */) {
				if (arg.isStatic) {
					arg.content = camelize(arg.content);
				}
				else {
					// e.g. :[name].camel="count"
					arg.content = `${context.helperString(CAMELIZE)}(${arg.content})`;
				}
			}
			else {
				arg.children.unshift(`${context.helperString(CAMELIZE)}(`);
				arg.children.push(`)`);
			}
		}
		// e.g. :[name].camel=""
		if (!exp ||
			(exp.type === 4 /* SIMPLE_EXPRESSION */ && !exp.content.trim())) {
			// v-bind缺少表达式（绑定值）
			context.onError(createCompilerError(33 /* X_V_BIND_NO_EXPRESSION */, loc));
			return {
				props: [createObjectProperty(arg, createSimpleExpression('', true, loc))]
			};
		}
		return {
			props: [createObjectProperty(arg, exp)]
		};
	};

	/**
	 * 转换v-text指令（traverseNode）
	 */
	const transformText = (node, context) => {
		/*
			e.g. 
			<div @click.right="getData">
				<div>abc {{ counter }} {{ counter }}</div>
				纯文本节点
			</div>

			解释：
			从子节点开始转换，冒泡到父节点。
			第一次先转换：
				<div>abc {{ counter }} {{ counter }}</div>
				| node.children.length为4
				| 经过for循环后，node.children.length为1

			第二次转换：
				<div @click.right="getData">
					<div>abc {{ counter }} {{ counter }}<.div>
					123
				</div>
				| node.children.length为2
				| 经过for循环后，还有文本节点（纯文本节点）。
		*/
		if (node.type === 0 /* ROOT */ ||
			node.type === 1 /* ELEMENT */ ||
			node.type === 11 /* FOR */ ||
			node.type === 10 /* IF_BRANCH */) {
			return () => {
				const children = node.children;
				let currentContainer = undefined;
				let hasText = false;
				for (let i = 0; i < children.length; i++) {
					const child = children[i];
					if (isText(child)) {
						hasText = true;
						for (let j = i + 1; j < children.length; j++) {
							const next = children[j];
							if (isText(next)) {
								if (!currentContainer) {
									currentContainer = children[i] = {
										type: 8 /* COMPOUND_EXPRESSION */,
										loc: child.loc,
										children: [child]
									};
								}
								// 合并相邻节点到当前节点
								// 即：<div>abc {{ counter}} {{ counter }}</div>
								// node.children.length为4，合并后，node.children.length为1
								currentContainer.children.push(` + `, next);
								children.splice(j, 1);
								j--;
							}
							else {
								currentContainer = undefined;
								break;
							}
						}
					}
				}

				// 如果没有文本节点，或者children.length为1，意味着已经转换完了，终止函数
				if (!hasText ||
					(children.length === 1 &&
						(node.type === 0 /* ROOT */ ||
							(node.type === 1 /* ELEMENT */ &&
								node.tagType === 0 /* ELEMENT */)))) {
					return;
				}

				// 能走到这里意味着有纯文本没有被转化（纯文本节点），通过createTextVNode助手方法来创建
				for (let i = 0; i < children.length; i++) {
					const child = children[i];
					if (isText(child) || child.type === 8 /* COMPOUND_EXPRESSION */) {
						const callArgs = [];
						if (child.type !== 2 /* TEXT */ || child.content !== ' ') {
							callArgs.push(child);
						}
						
						// 标记动态的插值语法绑定值
						/*
							e.g. {{ name }}
							<div @click.right="getData">
								<div>abc {{ counter }} {{ counter }}</div>
								{{ name }}
							</div>
						*/
						if (!context.ssr && child.type !== 2 /* TEXT */) {
							callArgs.push(`${1 /* TEXT */} /* ${PatchFlagNames[1 /* TEXT */]} */`);
						}
						children[i] = {
							type: 12 /* TEXT_CALL */,
							content: child,
							loc: child.loc,
							codegenNode: createCallExpression(context.helper(CREATE_TEXT), callArgs)
						};
					}
				}
			};
		}
	};

	const seen = new WeakSet();
	/**
	 * 转换v-once指令（traverseNode）
	 */
	const transformOnce = (node, context) => {
		if (node.type === 1 /* ELEMENT */ && findDir(node, 'once', true)) {
			if (seen.has(node)) {
				return;
			}
			seen.add(node);
			// tracking掉该节点（只做一次渲染，随后的重新渲染，该节点及其所有子节点都被视为静态内容并跳过
			context.helper(SET_BLOCK_TRACKING);
			// 缓存
			return () => {
				const cur = context.currentNode;
				if (cur.codegenNode) {
					cur.codegenNode = context.cache(cur.codegenNode, true /* isVNode */);
				}
			};
		}
	};

	// 转换v-model指令
	const transformModel = (dir, node, context) => {
		/*
			e.g. 
			v-model:foo="counter"
			exp = {
				content: "counter",
				isConstant: false,
				isStatic: false,
				loc: { // 位置信息 },
				type: 4
			}
			arg = {
				content: "foo",
				isConstant: true,
				isStatic: true,
				loc: { // 位置信息 },
				type: 4
			}
		*/
		const { exp, arg } = dir;
		if (!exp) {
			// v-model缺少表达式（绑定值）
			context.onError(createCompilerError(40 /* X_V_MODEL_NO_EXPRESSION */, dir.loc));
			// 创建空的props
			return createTransformProps();
		}
		const expString = exp.type === 4 /* SIMPLE_EXPRESSION */ ? exp.content : exp.loc.source;
		if (!isMemberExpression(expString)) {
			// v-model绑定的值必须为一个有效的JavaScript分子表达式
			context.onError(createCompilerError(41 /* X_V_MODEL_MALFORMED_EXPRESSION */, exp.loc));
			return createTransformProps();
		}
		const propName = arg ? arg : createSimpleExpression('modelValue', true);
		// 创建事件名
		const eventName = arg
			? isStaticExp(arg)
				? `onUpdate:${arg.content}`
				: createCompoundExpression(['"onUpdate:" + ', arg])
			: `onUpdate:modelValue`;
		const props = [
			// modelValue: foo
			createObjectProperty(propName, dir.exp),
			// "onUpdate:modelValue": $event => (foo = $event)
			createObjectProperty(eventName, createCompoundExpression([`$event => (`, exp, ` = $event)`]))
		];
		// modelModifiers: { foo: true, "bar-baz": true }
		if (dir.modifiers.length && node.tagType === 1 /* COMPONENT */) {
			const modifiers = dir.modifiers
				.map(m => (isSimpleIdentifier(m) ? m : JSON.stringify(m)) + `: true`)
				.join(`, `);
			const modifiersKey = arg
				? isStaticExp(arg)
					? `${arg.content}Modifiers`
					: createCompoundExpression([arg, ' + "Modifiers"'])
				: `modelModifiers`;
			props.push(createObjectProperty(modifiersKey, createSimpleExpression(`{ ${modifiers} }`, false, dir.loc, true)));
		}
		return createTransformProps(props);
	};

	// 创建转换的props属性
	function createTransformProps(props = []) {
		return { props };
	}

	// 获取预配置转换方法
	function getBaseTransformPreset(prefixIdentifiers) {
		return [
			[
				transformOnce,
				transformIf,
				transformFor,
				...([transformExpression]
				),
				transformSlotOutlet,
				transformElement,
				trackSlotScopes,
				transformText
			],
			{
				on: transformOn,
				bind: transformBind,
				model: transformModel
			}
		];
	}

	// 编译模板
	function baseCompile(template, options = {}) {
		const onError = options.onError || defaultOnError;
		const isModuleMode = options.mode === 'module';
		{
			// prefixIdentifiers => 前缀标识符 如果为true，表示需要添加前缀，为false，表示可以使用with: 严格模式下不可以使用with
			if (options.prefixIdentifiers === true) {
				// 在构建编译器的过程中不支持 prefixIdentifiers === true 参数
				onError(createCompilerError(45 /* X_PREFIX_ID_NOT_SUPPORTED */));
			}
			// mode => ES module模式
			else if (isModuleMode) {
				// 在构建编译器的过程中不支持 mode === 'module'参数
				onError(createCompilerError(46 /* X_MODULE_MODE_NOT_SUPPORTED */));
			}
		}
		const prefixIdentifiers = !true;
		if (options.cacheHandlers) {
			// 在构建编译器过程中不支持cacheHandlers参数
			onError(createCompilerError(47 /* X_CACHE_HANDLER_NOT_SUPPORTED */));
		}
		if (options.scopeId && !isModuleMode) {
			// scopeId只有在module模式下才支持
			onError(createCompilerError(48 /* X_SCOPE_ID_NOT_SUPPORTED */));
		}
		// 构建AST语法树
		const ast = isString(template) ? baseParse(template, options) : template;
		const [nodeTransforms, directiveTransforms] = getBaseTransformPreset();

		// 开始转换AST语法树
		transform(ast, extend({}, options, {
			prefixIdentifiers,
			nodeTransforms: [
				...nodeTransforms,
				...(options.nodeTransforms || []) // user transforms
			],
			directiveTransforms: extend({}, directiveTransforms, options.directiveTransforms || {} // user transforms
			)
		}));
		// 根据转换后的AST生成代码
		return generate(ast, extend({}, options, {
			prefixIdentifiers
		}));
	}

	// noop => 空
	// v-cloak指令的作用：防止页面加载时出现闪烁问题（解决插值表达式的闪烁问题）
	const noopDirectiveTransform = () => ({ props: [] });

	const V_MODEL_RADIO = Symbol(`vModelRadio`);
	const V_MODEL_CHECKBOX = Symbol(`vModelCheckbox`);
	const V_MODEL_TEXT = Symbol(`vModelText`);
	const V_MODEL_SELECT = Symbol(`vModelSelect`);
	const V_MODEL_DYNAMIC = Symbol(`vModelDynamic`);
	const V_ON_WITH_MODIFIERS = Symbol(`vOnModifiersGuard`);
	const V_ON_WITH_KEYS = Symbol(`vOnKeysGuard`);
	const V_SHOW = Symbol(`vShow`);
	const TRANSITION$1 = Symbol(`Transition`);
	const TRANSITION_GROUP = Symbol(`TransitionGroup`);
	registerRuntimeHelpers({
		[V_MODEL_RADIO]: `vModelRadio`,
		[V_MODEL_CHECKBOX]: `vModelCheckbox`,
		[V_MODEL_TEXT]: `vModelText`,
		[V_MODEL_SELECT]: `vModelSelect`,
		[V_MODEL_DYNAMIC]: `vModelDynamic`,
		[V_ON_WITH_MODIFIERS]: `withModifiers`,
		[V_ON_WITH_KEYS]: `withKeys`,
		[V_SHOW]: `vShow`,
		[TRANSITION$1]: `Transition`,
		[TRANSITION_GROUP]: `TransitionGroup`
	});

	let decoder;
	// 解析浏览器的HTML编码
	// e.g. '&nbsp;\n    ' => '  \n    '
	function decodeHtmlBrowser(raw) {
		(decoder || (decoder = document.createElement('div'))).innerHTML = raw;
		return decoder.textContent;
	}

	// 判断标签是否是原始的（无损的）文本标签
	const isRawTextContainer = /*#__PURE__*/ makeMap('style,iframe,script,noscript', true);
	const parserOptions = {
		isVoidTag,
		// 判断标签是否为系统自带的标签
		isNativeTag: tag => isHTMLTag(tag) || isSVGTag(tag),
		isPreTag: tag => tag === 'pre',
		decodeEntities: decodeHtmlBrowser,
		// 判断标签是否为Transition或TransitionGroup
		isBuiltInComponent: (tag) => {
			if (isBuiltInType(tag, `Transition`)) {
				return TRANSITION$1;
			}
			else if (isBuiltInType(tag, `TransitionGroup`)) {
				return TRANSITION_GROUP;
			}
		},
		// 获取标签的命名空间
		// https://html.spec.whatwg.org/multipage/parsing.html#tree-construction-dispatcher
		getNamespace(tag, parent) {
			let ns = parent ? parent.ns : 0 /* HTML */;
			if (parent && ns === 2 /* MATH_ML */) {
				if (parent.tag === 'annotation-xml') {
					if (tag === 'svg') {
						return 1 /* SVG */;
					}
					if (parent.props.some(a => a.type === 6 /* ATTRIBUTE */ &&
						a.name === 'encoding' &&
						a.value != null &&
						(a.value.content === 'text/html' ||
							a.value.content === 'application/xhtml+xml'))) {
						ns = 0 /* HTML */;
					}
				}
				else if (/^m(?:[ions]|text)$/.test(parent.tag) &&
					tag !== 'mglyph' &&
					tag !== 'malignmark') {
					ns = 0 /* HTML */;
				}
			}
			else if (parent && ns === 1 /* SVG */) {
				if (parent.tag === 'foreignObject' ||
					parent.tag === 'desc' ||
					parent.tag === 'title') {
					ns = 0 /* HTML */;
				}
			}
			if (ns === 0 /* HTML */) {
				if (tag === 'svg') {
					return 1 /* SVG */;
				}
				if (tag === 'math') {
					return 2 /* MATH_ML */;
				}
			}
			// 默认为HTML
			return ns;
		},
		// 获取文本的模式
		// https://html.spec.whatwg.org/multipage/parsing.html#parsing-html-fragments
		getTextMode({ tag, ns }) {
			if (ns === 0 /* HTML */) {
				// 在IE浏览器中textarea的placeholder有一个bug，浏览器会将placeholder的内容会被作为textarea的文本节点放入
				if (tag === 'textarea' || tag === 'title') {
					return 1 /* RCDATA */;
				}
				if (isRawTextContainer(tag)) {
					return 2 /* RAWTEXT */;
				}
			}
			return 0 /* DATA */;
		}
	};

	// 转换style属性
	const transformStyle = node => {
		if (node.type === 1 /* ELEMENT */) {
			node.props.forEach((p, i) => {
				if (p.type === 6 /* ATTRIBUTE */ && p.name === 'style' && p.value) {
					// 将p替换成一个表达式形式的对象
					node.props[i] = {
						type: 7 /* DIRECTIVE */,
						name: `bind`,
						arg: createSimpleExpression(`style`, true, p.loc),
						exp: parseInlineCSS(p.value.content, p.loc),
						modifiers: [],
						loc: p.loc
					};
				}
			});
		}
	};

	// 处理行间css样式
	const parseInlineCSS = (cssText, loc) => {
		const normalized = parseStringStyle(cssText);
		return createSimpleExpression(JSON.stringify(normalized), false, loc, true);
	};

	// 创建DOM元素编译过程中产生的错误
	function createDOMCompilerError(code, loc) {
		return createCompilerError(code, loc, DOMErrorMessages);
	}
	const DOMErrorMessages = {
		[49 /* X_V_HTML_NO_EXPRESSION ----- v-html缺少表达式 */]: `v-html is missing expression.`,
		[50 /* X_V_HTML_WITH_CHILDREN ----- v-html会重写子元素，如果v-html含有子元素就报错 */]: `v-html will override element children.`,
		[51 /* X_V_TEXT_NO_EXPRESSION ----- v-text缺少表达式 */]: `v-text is missing expression.`,
		[52 /* X_V_TEXT_WITH_CHILDREN ----- v-text会重写子元素，如果v-text含有子元素就报错 */]: `v-text will override element children.`,
		[53 /* X_V_MODEL_ON_INVALID_ELEMENT ----- v-model只能用在input、textarea、select标签 */]: `v-model can only be used on <input>, <textarea> and <select> elements.`,
		[54 /* X_V_MODEL_ARG_ON_ELEMENT ----- v-model指令不能绑定参数 */]: `v-model argument is not supported on plain elements.`,
		[55 /* X_V_MODEL_ON_FILE_INPUT_ELEMENT ----- input的type不能为file类型 */]: `v-model cannot be used on file inputs since they are read-only. Use a v-on:change listener instead.`,
		[56 /* X_V_MODEL_UNNECESSARY_VALUE ----- v-model不需要绑定value属性，因为这样会干扰到v-model的使用 */]: `Unnecessary value binding used alongside v-model. It will interfere with v-model's behavior.`,
		[57 /* X_V_SHOW_NO_EXPRESSION ----- v-show缺少表达式 */]: `v-show is missing expression.`,
		[58 /* X_TRANSITION_INVALID_CHILDREN ----- Transition期待只有一个直接子元素或一个直接子组件 */]: `<Transition> expects exactly one child element or component.`,
		[59 /* X_IGNORED_SIDE_EFFECT_TAG ----- script标签和style标签会被忽略 */]: `Tags with side effect (<script> and <style>) are ignored in client component templates.`
	};

	// 转换v-html指令
	const transformVHtml = (dir, node, context) => {
		const { exp, loc } = dir;
		if (!exp) {
			// v-html缺少表达式
			context.onError(createDOMCompilerError(49 /* X_V_HTML_NO_EXPRESSION */, loc));
		}
		if (node.children.length) {
			// v-html会重写元素的子元素内容（即清空后重置）
			context.onError(createDOMCompilerError(50 /* X_V_HTML_WITH_CHILDREN */, loc));
			node.children.length = 0;
		}
		return {
			props: [
				// 创建简易表达式，content为innerHTML
				createObjectProperty(createSimpleExpression(`innerHTML`, true, loc), exp || createSimpleExpression('', true))
			]
		};
	};

	// 转换v-text指令
	const transformVText = (dir, node, context) => {
		const { exp, loc } = dir;
		if (!exp) {
			// v-text缺失表达式
			context.onError(createDOMCompilerError(51 /* X_V_TEXT_NO_EXPRESSION */, loc));
		}
		if (node.children.length) {
			// v-text会重写元素的子元素内容（即清空后重置）
			context.onError(createDOMCompilerError(52 /* X_V_TEXT_WITH_CHILDREN */, loc));
			node.children.length = 0;
		}
		return {
			props: [
				createObjectProperty(createSimpleExpression(`textContent`, true), exp
					// 创建call表达式对象，编译代码时将会调用toDisplayString方法
					? createCallExpression(context.helperString(TO_DISPLAY_STRING), [exp], loc)
					// 创建空内容的静态的简单表达式
					: createSimpleExpression('', true))
			]
		};
	};

	// 转换v-model指令
	const transformModel$1 = (dir, node, context) => {
		const baseResult = transformModel(dir, node, context);
		// 通过基本转换v-model方法处理后返回的结果不存在props或者v-model绑定的是组件
		if (!baseResult.props.length || node.tagType === 1 /* COMPONENT */) {
			return baseResult;
		}
		if (dir.arg) {
			// v-model指令不能绑定参数（自定义指令可以）
			// e.g. 动态的 v-model:[name] 非动态的 v-model:name
			context.onError(createDOMCompilerError(54 /* X_V_MODEL_ARG_ON_ELEMENT */, dir.arg.loc));
		}
		

		// 检查重复属性值
		function checkDuplicatedValue() {
			const value = findProp(node, 'value'); // value属性
			if (value) { // 如果有value属性值，则抛出错误
				context.onError(createDOMCompilerError(56 /* X_V_MODEL_UNNECESSARY_VALUE */, value.loc));
			}
		}
		const { tag } = node;
		// 判断标签是否为自定义标签
		const isCustomElement = context.isCustomElement(tag);
		if (tag === 'input' ||
			tag === 'textarea' ||
			tag === 'select' ||
			isCustomElement) {
			let directiveToUse = V_MODEL_TEXT;
			let isInvalidType = false; // 是否为无效类型
			if (tag === 'input' || isCustomElement) {
				const type = findProp(node, `type`); // type属性值
				if (type) {
					if (type.type === 7 /* DIRECTIVE */) {
						// :type="foo"
						directiveToUse = V_MODEL_DYNAMIC;
					}
					else if (type.value) {
						switch (type.value.content) {
							case 'radio':
								directiveToUse = V_MODEL_RADIO;
								break;
							case 'checkbox':
								directiveToUse = V_MODEL_CHECKBOX;
								break;
							case 'file':
								isInvalidType = true;
								context.onError(createDOMCompilerError(55 /* X_V_MODEL_ON_FILE_INPUT_ELEMENT */, dir.loc));
								break;
							default:
								// 默认为text类型
								checkDuplicatedValue();
								break;
						}
					}
				}
				else if (hasDynamicKeyVBind(node)) {
					// element has bindings with dynamic keys, which can possibly contain
					// "type".
					directiveToUse = V_MODEL_DYNAMIC;
				}
				else {
					// text type
					checkDuplicatedValue();
				}
			}
			else if (tag === 'select') {
				directiveToUse = V_MODEL_SELECT;
			}
			else {
				// textarea
				checkDuplicatedValue();
			}
			if (!isInvalidType) {
				baseResult.needRuntime = context.helper(directiveToUse);
			}
		}
		else {
			// v-model只能用于<input>, <textarea> 和 <select>标签
			context.onError(createDOMCompilerError(53 /* X_V_MODEL_ON_INVALID_ELEMENT */, dir.loc));
		}

		// 到这一步v-model不再需要`modelValue`属性
		// 把他过滤掉，以减少内存开销量
		// （因为v-model属性只是个语法糖，最后会转换成onUpdate:modelValue）
		// e.g. <input type="text" v-bind:value="msg" v-on:input="msg = $event.target.value">
		baseResult.props = baseResult.props.filter(p => !(p.key.type === 4 /* SIMPLE_EXPRESSION */ &&
			p.key.content === 'modelValue'));
		return baseResult;
	};

	const isEventOptionModifier = /*#__PURE__*/ makeMap(`passive,once,capture`);
	const isNonKeyModifier = /*#__PURE__*/ makeMap(
		// event propagation management
		`stop,prevent,self,` +
		// system modifiers + exact
		`ctrl,shift,alt,meta,exact,` +
		// mouse
		`middle`);
	const maybeKeyModifier = /*#__PURE__*/ makeMap('left,right');
	const isKeyboardEvent = /*#__PURE__*/ makeMap(`onkeyup,onkeydown,onkeypress`, true);

	// 解析修饰符
	const resolveModifiers = (key, modifiers) => {
		// 键盘修饰词 e.g. onkeyup、onkeydown、onkeypress
		const keyModifiers = [];
		// 不属于关键字的修饰词 e.g. stop、prevent、self、ctrl、shift、alt、meta、exact、middle、left、right
		const nonKeyModifiers = [];
		// 事件修饰词 e.g. passive、once、capture
		const eventOptionModifiers = [];
		for (let i = 0; i < modifiers.length; i++) {
			const modifier = modifiers[i];
			if (isEventOptionModifier(modifier)) {
				// e.g. .passive & .capture
				eventOptionModifiers.push(modifier);
			}
			else {
				if (maybeKeyModifier(modifier)) {
					if (isStaticExp(key)) {
						if (isKeyboardEvent(key.content)) {
							keyModifiers.push(modifier);
						}
						else {
							nonKeyModifiers.push(modifier);
						}
					}
					else {
						keyModifiers.push(modifier);
						nonKeyModifiers.push(modifier);
					}
				}
				else {
					if (isNonKeyModifier(modifier)) {
						nonKeyModifiers.push(modifier);
					}
					else {
						keyModifiers.push(modifier);
					}
				}
			}
		}
		return {
			keyModifiers,
			nonKeyModifiers,
			eventOptionModifiers
		};
	};

	// 转换click
	const transformClick = (key, event) => {
		const isStaticClick = isStaticExp(key) && key.content.toLowerCase() === 'onclick';
		return isStaticClick
			// 如果为静态表达式，且v-on绑定的是click类型，直接创建简易的表达式对象
			// 将key对象中的content属性值修改成event
			? createSimpleExpression(event, true)
			: key.type !== 4 /* SIMPLE_EXPRESSION */

				// 创建复杂的表达式对象（动态绑定的事件）
				// e.g. v-on:[eventType].right="click"
				? createCompoundExpression([
					`(`,
					key,
					// 如果eventType为click，则返回传入的event（onContextmenu | onMouseup）
					`) === "onClick" ? "${event}" : (`,
					key,
					`)`
				])
				// 如果为静态表达式，但v-on绑定的不是click类型，默认不做处理
				: key;
	};
	// 转换v-on指令
	const transformOn$1 = (dir, node, context) => {
		return transformOn(dir, node, context, baseResult => {
			// 该回调主要是处理修饰词，如果修饰词不存在，则终止回调方法
			const { modifiers } = dir;
			if (!modifiers.length)
				return baseResult;
			let { key, value: handlerExp /* v-on绑定的表达式，已被转成对象形式 */ } = baseResult.props[0];
			const { keyModifiers, nonKeyModifiers, eventOptionModifiers } = resolveModifiers(key, modifiers);

			// 格式化click.right and click.middle
			if (nonKeyModifiers.includes('right')) {
				key = transformClick(key, `onContextmenu`);
			}
			if (nonKeyModifiers.includes('middle')) {
				key = transformClick(key, `onMouseup`);
			}
			if (nonKeyModifiers.length) {
				// 创建call表达式对象，编译代码时会调用withModifiers方法来对修饰词进行守卫拦截，处理相关逻辑判断
				handlerExp = createCallExpression(context.helper(V_ON_WITH_MODIFIERS), [
					handlerExp,
					JSON.stringify(nonKeyModifiers)
				]);
			}
			if (keyModifiers.length &&
				// 如果事件名是动态的，或者事件属于键盘事件，
				// 则创建call表达式对象，调用withKeys方法来对修饰词进行拦截，处理相关逻辑判断
				(!isStaticExp(key) || isKeyboardEvent(key.content))) {
				handlerExp = createCallExpression(context.helper(V_ON_WITH_KEYS), [
					handlerExp,
					JSON.stringify(keyModifiers)
				]);
			}

			// e.g. .passive & .capture & .once
			if (eventOptionModifiers.length) {
				const modifierPostfix = eventOptionModifiers.map(capitalize).join('');
				key = isStaticExp(key)
					// 静态的事件名，则创建简易的表达式对象 e.g. onClickOnceCapture
					? createSimpleExpression(`${key.content}${modifierPostfix}`, true)
					// 动态的事件名，则创建复杂的表达式对象
					: createCompoundExpression([`(`, key, `) + "${modifierPostfix}"`]);
			}
			return {
				props: [createObjectProperty(key, handlerExp)]
			};
		});
	};

	// 转换v-show指令
	const transformShow = (dir, node, context) => {
		const { exp, loc } = dir;
		if (!exp) {
			context.onError(createDOMCompilerError(57 /* X_V_SHOW_NO_EXPRESSION */, loc));
		}
		return {
			props: [],
			needRuntime: context.helper(V_SHOW)
		};
	};

	// 检验Transition标签，不能包含多个子元素，否则将输出警告信息
	const warnTransitionChildren = (node, context) => {
		if (node.type === 1 /* ELEMENT */ &&
			node.tagType === 1 /* COMPONENT */) {
			// Transition
			const component = context.isBuiltInComponent(node.tag);
			if (component === TRANSITION$1) {
				return () => {
					if (node.children.length && hasMultipleChildren(node)) {
						context.onError(createDOMCompilerError(58 /* X_TRANSITION_INVALID_CHILDREN */, {
							start: node.children[0].loc.start,
							end: node.children[node.children.length - 1].loc.end,
							source: ''
						}));
					}
				};
			}
		}
	};
	// 判断node是否含有多个子元素
	function hasMultipleChildren(node) {
		// #1352 filter out potential comment nodes.
		const children = (node.children = node.children.filter(c => c.type !== 3 /* COMMENT */));
		const child = children[0];
		return (children.length !== 1 ||
			child.type === 11 /* FOR */ ||
			// e.g.
			// 1. <template v-if="true"><div></div><div></div></template>
			// 2. <div v-if="true" v-for="item in list"></div>
			(child.type === 9 /* IF */ && child.branches.some(hasMultipleChildren)));
	}

	// 判断标签是否是纯文本标签，不要编译里面的内容
	// 包含<script type="x/template"></script>
	const ignoreSideEffectTags = (node, context) => {
		if (node.type === 1 /* ELEMENT */ &&
			node.tagType === 0 /* ELEMENT */ &&
			(node.tag === 'script' || node.tag === 'style')) {
			context.onError(createDOMCompilerError(59 /* X_IGNORED_SIDE_EFFECT_TAG */, node.loc));
			context.removeNode();
		}
	};

	// DOM样式转换函数
	const DOMNodeTransforms = [
		transformStyle,
		...([warnTransitionChildren])
	];
	// DOM命令转换函数
	const DOMDirectiveTransforms = {
		cloak: noopDirectiveTransform,
		html: transformVHtml,
		text: transformVText,
		model: transformModel$1,
		on: transformOn$1,
		show: transformShow
	};
	// 编译template
	function compile$1(template, options = {}) {
		return baseCompile(template, extend({}, parserOptions, options, {
			nodeTransforms: [
				ignoreSideEffectTags,
				...DOMNodeTransforms,
				...(options.nodeTransforms || [])
			],
			directiveTransforms: extend({}, DOMDirectiveTransforms, options.directiveTransforms || {}),
			transformHoist: null
		}));
	}

	// 入口
	initDev();
	/**
	 * 将模板编译成函数
	 * @param {String|ElementObject} template 模板字符串或者Element
	 * @param {Object} options 编译选项
	 */
	const compileCache = Object.create(null);
	function compileToFunction(template, options) {
		if (!isString(template)) {
			if (template.nodeType) {
				template = template.innerHTML;
			}
			else {
				// 无效的template
				warn(`invalid template option: `, template);
				return NOOP;
			}
		}
		const key = template;
		// 缓存已经编译过的模板
		const cached = compileCache[key];
		if (cached) {
			return cached;
		}

		// template直接传ID
		if (template[0] === '#') {
			const el = document.querySelector(template);
			if (!el) {
				warn(`Template element not found or is empty: ${template}`);
			}
			template = el ? el.innerHTML : ``;
		}
		// 编译出code代码函数
		const { code } = compile$1(template, extend({
			hoistStatic: true,
			onError(err) {
				{
					const message = `Template compilation error: ${err.message}`;
					// 获取开始位置和结束位置
					const codeFrame = err.loc &&
						generateCodeFrame(template, err.loc.start.offset, err.loc.end.offset);
					warn(codeFrame ? `${message}\n${codeFrame}` : message);
				}
			}
		}, options));

		// 通过代码片段声明渲染函数
		const render = (new Function(code)()
		);
		render._rc = true;
		return (compileCache[key] = render);
	}
	registerRuntimeCompiler(compileToFunction);

	exports.BaseTransition = BaseTransition;
	exports.Comment = Comment;
	exports.Fragment = Fragment;
	exports.KeepAlive = KeepAlive;
	exports.Static = Static;
	exports.Suspense = Suspense;
	exports.Teleport = Teleport;
	exports.Text = Text;
	exports.Transition = Transition;
	exports.TransitionGroup = TransitionGroup;
	exports.callWithAsyncErrorHandling = callWithAsyncErrorHandling;
	exports.callWithErrorHandling = callWithErrorHandling;
	exports.camelize = camelize;
	exports.capitalize = capitalize;
	exports.cloneVNode = cloneVNode;
	exports.compile = compileToFunction;
	exports.computed = computed$1;
	exports.createApp = createApp;
	exports.createBlock = createBlock;
	exports.createCommentVNode = createCommentVNode;
	exports.createHydrationRenderer = createHydrationRenderer;
	exports.createRenderer = createRenderer;
	exports.createSSRApp = createSSRApp;
	exports.createSlots = createSlots;
	exports.createStaticVNode = createStaticVNode;
	exports.createTextVNode = createTextVNode;
	exports.createVNode = createVNode;
	exports.customRef = customRef;
	exports.defineAsyncComponent = defineAsyncComponent;
	exports.defineComponent = defineComponent;
	exports.getCurrentInstance = getCurrentInstance;
	exports.getTransitionRawChildren = getTransitionRawChildren;
	exports.h = h;
	exports.handleError = handleError;
	exports.hydrate = hydrate;
	exports.initCustomFormatter = initCustomFormatter;
	exports.inject = inject;
	exports.isProxy = isProxy;
	exports.isReactive = isReactive;
	exports.isReadonly = isReadonly;
	exports.isRef = isRef;
	exports.isVNode = isVNode;
	exports.markRaw = markRaw;
	exports.mergeProps = mergeProps;
	exports.nextTick = nextTick;
	exports.onActivated = onActivated;
	exports.onBeforeMount = onBeforeMount;
	exports.onBeforeUnmount = onBeforeUnmount;
	exports.onBeforeUpdate = onBeforeUpdate;
	exports.onDeactivated = onDeactivated;
	exports.onErrorCaptured = onErrorCaptured;
	exports.onMounted = onMounted;
	exports.onRenderTracked = onRenderTracked;
	exports.onRenderTriggered = onRenderTriggered;
	exports.onUnmounted = onUnmounted;
	exports.onUpdated = onUpdated;
	exports.openBlock = openBlock;
	exports.popScopeId = popScopeId;
	exports.provide = provide;
	exports.proxyRefs = proxyRefs;
	exports.pushScopeId = pushScopeId;
	exports.queuePostFlushCb = queuePostFlushCb;
	exports.reactive = reactive;
	exports.readonly = readonly;
	exports.ref = ref;
	exports.registerRuntimeCompiler = registerRuntimeCompiler;
	exports.render = render;
	exports.renderList = renderList;
	exports.renderSlot = renderSlot;
	exports.resolveComponent = resolveComponent;
	exports.resolveDirective = resolveDirective;
	exports.resolveDynamicComponent = resolveDynamicComponent;
	exports.resolveTransitionHooks = resolveTransitionHooks;
	exports.setBlockTracking = setBlockTracking;
	exports.setDevtoolsHook = setDevtoolsHook;
	exports.setTransitionHooks = setTransitionHooks;
	exports.shallowReactive = shallowReactive;
	exports.shallowReadonly = shallowReadonly;
	exports.shallowRef = shallowRef;
	exports.ssrContextKey = ssrContextKey;
	exports.ssrUtils = ssrUtils;
	exports.toDisplayString = toDisplayString;
	exports.toHandlerKey = toHandlerKey;
	exports.toHandlers = toHandlers;
	exports.toRaw = toRaw;
	exports.toRef = toRef;
	exports.toRefs = toRefs;
	exports.transformVNodeArgs = transformVNodeArgs;
	exports.triggerRef = triggerRef;
	exports.unref = unref;
	exports.useCssModule = useCssModule;
	exports.useCssVars = useCssVars;
	exports.useSSRContext = useSSRContext;
	exports.useTransitionState = useTransitionState;
	exports.vModelCheckbox = vModelCheckbox;
	exports.vModelDynamic = vModelDynamic;
	exports.vModelRadio = vModelRadio;
	exports.vModelSelect = vModelSelect;
	exports.vModelText = vModelText;
	exports.vShow = vShow;
	exports.version = version;
	exports.warn = warn;
	exports.watch = watch;
	exports.watchEffect = watchEffect;
	exports.withCtx = withCtx;
	exports.withDirectives = withDirectives;
	exports.withKeys = withKeys;
	exports.withModifiers = withModifiers;
	exports.withScopeId = withScopeId;

	Object.defineProperty(exports, '__esModule', { value: true });

	return exports;

}({}));
