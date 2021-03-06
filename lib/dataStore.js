/**
 * Provides search functions over the data store, which is file-based.
 */
var fs = require('fs'), 
	format = require('util').format, 
	EventEmitter = require('events').EventEmitter,
	chokidar = require('chokidar'),
	ldap = require('ldapjs'),
	log = require('./logging').logDataStore
	async = require('async'),
	cb = require('cb'),
	u = require('underscore'),
	compact = u.compact,
	yaml = require('js-yaml')
	;

var store;

function findLayer(id) {
	return u.find(store.layers, function(layer) {
		return layer.id === id;
	})
}

function findUser(id) {
	return u.find(store.users, function(user) {
		return user.uid === id;
	})
}

/**
 * Finds the public keys of a user in the data store. If the user is not found,
 * the key list is +null+. If the user is found, but has no public keys, the key
 * list is an empty Array. Otherwise, it's an Array of the user's public keys.
 * 
 * Each key is guaranteed to span only one line, and to not end with a newline.
 */
function publicKeys(uid) {
	var user = findUser(uid);
	if ( !user )
		return null;
	else
		return user.publicKeys;
}

/**
 * Authenticates the password for a layer.
 * 
 * @callback error, String
 */
function authenticate(layer, credential, callback) {
	var password = process.env[format('LDAP_LAYER_%s_PASSWORD', layer.toUpperCase())];
	if ( password && credential === password )
		callback(null, password)
	else
		callback(new ldap.InvalidCredentialsError("Invalid login for layer " + layer));
}

/**
 * Provides the user list for a layer via EventEmitter. If the layer does not exist, no users are
 * emitted.
 * 
 * Events: +user+, +end+, +error+.
 */
function layerUsers(layerId) {
	var result = new EventEmitter();
	process.nextTick(function() {
		var layer = findLayer(layerId)
		if ( !layer ) {
			return result.emit('end');
		}
		layer.users.forEach(function(u) {
			result.emit('user', u);
		})
		result.emit('end');
	})
	return result;
}

/**
 * Provides the group list via EventEmitter. All groups are emitted; the result is not
 * filtered by whether a group is present in a layer.
 * 
 * Events: +group+, +end+, +error+.
 */
function groups() {
	var result = new EventEmitter();
	process.nextTick(function() {
		store.groups.forEach(function(g) {
			result.emit('group', g);
		})
		result.emit('end');
	})
	return result;
}

/**
 * Load the data store.
 * 
 * @param callback
 *          err, data
 */
function load(dir, callback) {
	
	/**
	 * Read the files in a directory. Each entry in the directory is passed to 
	 * +fn+. If the entry is a regular file, the body is passed to +fn+ along with the filename;
	 * otherwise it's just the filename.
	 * 
	 * Once all the files are listed, the callback is invoked with (err, result), where
	 * result is the accumulated output of all the +fn+ invocations.
	 */
	function loadDir(dir, fn, callback) {
		callback = cb(callback);
		
		var result = [];
		
		fs.readdir(dir, function(err, files) {
			if ( err ) return callback(err);
			
			var c = files.length;
			function accumulate() {
				try {
					result.push(fn.apply(null, Array.prototype.slice.call(arguments)));
				}
				catch (err) {
					return callback(err);
				}
				if ( 0 === --c ) {
					callback(null, result);
				}
			}
			
			files.forEach(function(file) {
				var fname = [ dir, file ].join('/');
				fs.lstat(fname, function(err, stats) {
					if ( err ) return callback(err);
					
					if ( stats.isFile() ) {
						fs.readFile(fname, 'utf-8', function(err, contents) {
							if ( err ) return callback(err);
							
							accumulate(file, contents);
						});
					}
					else if ( stats.isDirectory() ) {
						accumulate(file);
					}
					else if ( stats.isSymbolicLink() ) {
						accumulate(file);
					}
				});
			});
		});
	}

	/**
	 * Transform a filename into a uid, by splitting on '.'.
	 */
	function fileUid(filename) {
		var tokens = filename.split('.');
		if ( tokens.length === 0 )
			return tokens[0];
		return tokens.slice(0, tokens.length-1).join('.');
	}
	
	/**
	 * Load the users from the users/ directory. The uid is populated
	 * on each one.
	 */
	function loadUsers(callback) {
		loadDir([ dir, 'users' ].join('/'), function(filename, contents) {
			var user = yaml.safeLoad(contents);
			user.cn = user.uid = fileUid(filename);
			if ( !user.publicKeys ) user.publicKeys = [];
			return user;
		}, callback)
	}

	/**
	 * Load the users from the groups/ directory. The gid is populated
	 * on each one.
	 */
	function loadGroups(callback) {
		loadDir([ dir, 'groups' ].join('/'), function(filename, contents) {
			var group = yaml.safeLoad(contents);
			if ( !group )
				return null;
			if ( !group.gidNumber ) {
				return log.info("Missing gidNumber for group " + filename);
			}
			group.cn = fileUid(filename);
			return group;
		}, callback)
	}

	/**
	 * Load the authorization layers from the layers/ directory. Each Layer has an id
	 * and a +users+ field which lists the uid numbers of the users in the layer.
	 */
	function loadLayers(callback) {
		callback = cb(callback);
		
		loadDir([ dir, 'layers' ].join('/'), function(dirname) {
			return {
				id: dirname
			}
		}, function(err, layers) {
			if ( err ) return callback(err);
			
			var c = layers.length;
			layers.forEach(function(layer) {
				layer.users = [];
				loadDir([ dir, 'layers', layer.id ].join('/'), function(linkname) {
					var uid = fileUid(linkname);
					layer.users.push(uid);
				}, function(err) {
					if ( err ) 
						return callback(err);
					if ( 0 === --c )
						callback(null, layers);
				});
			});
		})
	}
	
	/**
	 * Resolve references within the raw data store objects.
	 */
	function buildDataStore(store) {
		var groups = {}, users = {};
		store.groups.forEach(function(group) {
			groups[group.cn] = group;
		})
		store.users.forEach(function(user) {
			users[user.uid] = user;
		})
		
		// Fix up the groups to refer to Group records
		store.users.forEach(function(user) {
			var group = groups[user.primaryGroup];
			if ( group )
				user.primaryGroup = group;
			else
				log.warn({primaryGroup: user.primaryGroup, uid: user.uid }, "Primary group %s not found for user %s", user.primaryGroup, user.uid);
			user.groups = u.compact(u.map(u.uniq(user.groups||[]), function(gid) {
				var group = groups[gid];
				if ( !group )
					log.warn({group: gid, user: user.uid }, "Group %s not found for user %s", gid, user.uid);
				else {
					if ( !group.members )
						group.members = [];
					group.members.push(user);
				}
				return group;
			}));
		});
		
		store.layers.forEach(function(layer) {
			layer.users = u.compact(u.map(layer.users, function(uid) {
				return users[uid];
			}));
		});
		
		return store;
	}

	async.parallel([loadGroups,
	                loadUsers, 
									loadLayers], 
			function(err, result) {
		if ( err ) 
			return callback(err);
		store = buildDataStore({
			dir: dir,
			users: compact(result[1]),
			groups: compact(result[0]),
			layers: compact(result[2])
		});
		log.debug(store);
		callback(null, store);
	});
}

/**
 * Initialize the data store from a specified directory.
 * 
 * @param callback
 *          invoked when ready
 */
function initialize(dir, callback) {
	if (store)
		return callback("data store is already initialized");

	var ready = false;
	chokidar.watch(dir, {
		ignored : /[\/\\]\./
	}).on('error', function(error) {
		log.warn("Error watching %s : %s", dir, error)
	}).on('ready', function() {
		load(dir, function(err) {
			if (err)
				return callback(err);
			log.info("data store loaded");
			ready = true;
			callback(null);
		});
	}).on('all', function(event, path) {
		if ( !ready )
			return;
		log.debug({ event: event, path: path }, "data store changed");
		load(dir, function(err, result) {
			if (err)
				log.err(err);
			log.debug("data store reloaded");
		});
	});
}

module.exports = {
	initialize : initialize,
	publicKeys : publicKeys,
	authenticate : authenticate,
	layerUsers : layerUsers,
	groups : groups,
}
