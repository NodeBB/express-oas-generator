const _ = require('lodash');
const fs = require('fs');
const swaggerUi = require('swagger-ui-express');
const utils = require('./lib/utils');
const processors = require('./lib/processors');
const listEndpoints = require('express-list-endpoints');

let packageJsonPath = `${process.cwd()}/package.json`;
let packageInfo;
let predefined;
let spec = {};

function updateSpecFromPackage({ apiSpecPath, baseUrlPath }) {

  /* eslint global-require : off */
  packageInfo = fs.existsSync(packageJsonPath) ? require(packageJsonPath) : {};

  spec.info = spec.info || {};

  if (packageInfo.name) {
    spec.info.title = packageInfo.name;
  }
  if (packageInfo.version) {
    spec.info.version = packageInfo.version;
  }
  if (packageInfo.license) {
    spec.info.license = { name: packageInfo.license };
  }
  packageInfo.baseUrlPath = packageInfo.baseUrlPath || baseUrlPath;
  if (packageInfo.baseUrlPath) {
    spec.info.description = `[Specification JSON](${packageInfo.baseUrlPath}${apiSpecPath}), base url : ${packageInfo.baseUrlPath}`;
  } else {
    spec.info.description = `[Specification JSON](${apiSpecPath})`;
  }
  if (packageInfo.description) {
    spec.info.description += `\n\n${packageInfo.description}`;
  }
}

const init = async function({ app, router, store, apiDocsPath, apiSpecPath, baseUrlPath, writeInterval }) {
  let blank = { swagger: '2.0', paths: {} };
  let stored = {};

  updateSpecFromPackage({ apiSpecPath, baseUrlPath });

  if (store) {
	try {
        stored = await store.getSpec()
	} catch (e) {
		console.warn(e);
	}
  }
  spec = _.merge(spec || {}, blank, stored);

  const endpoints = listEndpoints(app);
  endpoints.forEach(endpoint => {
    const params = [];
    let path = endpoint.path;
    const matches = path.match(/:([^/]+)/g);
    if (matches) {
      matches.forEach(found => {
        const paramName = found.substr(1);
        path = path.replace(found, `{${paramName}}`);
        params.push(paramName);
      });
    }

    if (!spec.paths[path]) {
      spec.paths[path] = {};
    }

    endpoint.methods.forEach(m => {
      spec.paths[path][m.toLowerCase()] = _.merge({
        summary: path,
        consumes: ['application/json'],
        parameters: params.map(p => ({
          name: p,
          in: 'path',
          required: true,
        })) || [],
        responses: {}
      }, spec.paths[path][m.toLowerCase()] || {});
    });
  });

  if (store) {
  	startWriting(store, writeInterval)
  }

  router.get(apiSpecPath, (req, res) => {
    res.json(patchSpec(predefined, { req, res }));
  });

  // this is not work? nodebb returns 404
  app.use(apiDocsPath, swaggerUi.serve, (req, res) => {
    swaggerUi.setup(patchSpec(predefined))(req, res);
  });
};

const patchSpec = function(predefined, options = {}) {
  return typeof predefined === 'object'
    ? utils.sortObject(_.merge(spec, predefined || {}))
    : typeof predefined === 'function' ? utils.sortObject(predefined(spec, options)) : utils.sortObject(spec)
};

const getPathKey = function(req) {
  if (!req.url) {
    return undefined;
  }

  if (spec.paths[req.url]) {
    return req.url;
  }

  const url = req.url.split('?')[0];
  const pathKeys = Object.keys(spec.paths);
  for (let i = 0; i < pathKeys.length; i += 1) {
    const pathKey = pathKeys[i];
    if (url.match(`^${pathKey.replace(/{([^/]+)}/g, '(?:([^\\\\/]+?))')}/?$`)) {
      return pathKey;
    }
  }
  return undefined;
};

function getMethod(req, aApiSpecPath) {
  if (req.url.startsWith('/' + aApiSpecPath)) {
    return undefined;
  }

  const m = req.method.toLowerCase();
  if (m === 'options') {
    return undefined;
  }

  const pathKey = getPathKey(req);
  if (!pathKey) {
    return undefined;
  }

  return { method: spec.paths[pathKey][m], pathKey };
}

function updateSchemesAndHost(req) {
  spec.schemes = spec.schemes || [];
  if (spec.schemes.indexOf(req.protocol) === -1) {
    spec.schemes.push(req.protocol);
  }
  if (!spec.host) {
    spec.host = req.get('host');
  }
}

module.exports.init = ({ app, router, store, predefinedSpec, apiDocsPath = '/api-docs', apiSpecPath = '/api-spec', baseUrlPath = '', writeInterval }) => {
  predefined = predefinedSpec;

  // middleware to handle responses
  app.use((req, res, next) => {
    try {
      const methodAndPathKey = getMethod(req, apiSpecPath);
      if (methodAndPathKey && methodAndPathKey.method) {
		processors.processResponse(res, methodAndPathKey.method);
      }
    } catch (e) {}
    next();
  });

  return function() {
	  app.use((req, res, next) => {
		  try {
			  const methodAndPathKey = getMethod(req, apiSpecPath);
			  if (methodAndPathKey && methodAndPathKey.method && methodAndPathKey.pathKey) {
				  const method = methodAndPathKey.method;
				  updateSchemesAndHost(req);
				  processors.processPath(req, method, methodAndPathKey.pathKey);
				  processors.processHeaders(req, method, spec);
				  processors.processBody(req, method);
				  processors.processQuery(req, method);
			  }
		  } catch (e) {}
		  next();
	  });
	  return init({ app, router, store, apiDocsPath, apiSpecPath, baseUrlPath, writeInterval });
  };
};

const startWriting = module.exports.startWriting = function (store, interval) {
	module.exports.writeIntervalId = setInterval(() => store.setSpec(spec),  interval || 10 * 1000)
};

module.exports.getSpec = () => {
  return patchSpec(predefined);
};

module.exports.setPackageInfoPath = pkgInfoPath => {
  packageJsonPath = `${process.cwd()}/${pkgInfoPath}/package.json`;
};
