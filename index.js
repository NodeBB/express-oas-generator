const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const utils = require('./lib/utils');
const processors = require('./lib/processors');
const listEndpoints = require('express-list-endpoints');

let packageJsonPath = `${process.cwd()}/package.json`;
let packageInfo;
let app;
let predefinedSpec;
let spec = {};

function updateSpecFromPackage(aApiSpecPath) {

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
  if (packageInfo.baseUrlPath) {
    spec.info.description = '[Specification JSON](' + packageInfo.baseUrlPath + '/' + aApiSpecPath + ') , base url : ' + packageInfo.baseUrlPath;
  } else {
    packageInfo.baseUrlPath = '';
    spec.info.description = '[Specification JSON](' + packageInfo.baseUrlPath + '/' + aApiSpecPath + ')';
  }
  if (packageInfo.description) {
    spec.info.description += `\n\n${packageInfo.description}`;
  }
}

const init = async function(aApiDocsPath, aApiSpecPath, aPath, aWriteInterval) {
  let blank = { swagger: '2.0', paths: {} };
  let parsed = {};

  updateSpecFromPackage(aApiSpecPath);

  if (aPath) {
	try {
		parsed = await readSpec(aPath)
	} catch (e) {
		console.warn(e);
	}
  }
  spec = _.merge(spec || {}, blank, parsed);

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

  spec = patchSpec(predefinedSpec);

  if (aPath) {
  	startWriting(aPath, aWriteInterval)
  }

  app.use(packageInfo.baseUrlPath + '/' + aApiSpecPath, (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(patchSpec(predefinedSpec), null, 2));
    next();
  });
  app.use(packageInfo.baseUrlPath + '/' + aApiDocsPath, swaggerUi.serve, (req, res) => {
    swaggerUi.setup(patchSpec(predefinedSpec))(req, res);
  });
};

const patchSpec = function(predefinedSpec) {
  return typeof predefinedSpec === 'object'
    ? utils.sortObject(_.merge(spec, predefinedSpec || {}))
    : predefinedSpec(spec);
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

module.exports.init = (aApp, aPredefinedSpec, aPath, aWriteInterval, aApiDocsPath = 'api-docs', aApiSpecPath = 'api-spec') => {
  app = aApp;
  predefinedSpec = aPredefinedSpec;

  // middleware to handle responses
  app.use((req, res, next) => {
    try {
      const methodAndPathKey = getMethod(req, aApiSpecPath);
      if (methodAndPathKey && methodAndPathKey.method) {
		processors.processResponse(res, methodAndPathKey.method);
      }
    } catch (e) {}
    next();
  });

  return function() {
	  app.use((req, res, next) => {
		  try {
			  const methodAndPathKey = getMethod(req, aApiSpecPath);
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
	  return init(aApiDocsPath, aApiSpecPath, aPath, aWriteInterval);
  };
};

const startWriting = module.exports.startWriting = function (aPath, interval) {
	module.exports.writeIntervalId = setInterval(() => writeSpec(aPath),  interval || 10 * 1000)
};

const stopWriting = module.exports.stopWriting = function () {
	clearInterval(module.exports.writeIntervalId)
};

const writeSpec = module.exports.writeSpec = function (aPath) {
	const fullPath = path.resolve(aPath);
	return new Promise((resolve, reject) => {
	    let spec2 = _.cloneDeep(spec);
        // let in the info always be auto-populated
	    delete spec2.info;
		fs.writeFile(fullPath, JSON.stringify(spec2, null, 2), 'utf8', err => {
			if (err) {
				reject(new Error(`Cannot write the specification into ${fullPath} because of ${err.message}`));
			}
			resolve();
		});
	});
};

const readSpec = module.exports.readSpec = function (aPath) {
	const fullPath = path.resolve(aPath);
	return new Promise((resolve, reject) => {
		fs.readFile(fullPath, { encoding: 'utf-8' }, (err, content) => {
			if (err) {
				return reject(err);
			}
            try {
				resolve(JSON.parse(content))
			} catch (e) {
				return reject(e);
			}
		})
	});
};

module.exports.getSpec = () => {
  return patchSpec(predefinedSpec);
};

module.exports.setPackageInfoPath = pkgInfoPath => {
  packageJsonPath = `${process.cwd()}/${pkgInfoPath}/package.json`;
};
