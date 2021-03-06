'use strict';
const pg = require('pg');

var queries = {};

queries['incr'] = `
INSERT INTO stats (pstart, hostname, pathname, val)
VALUES ($1::varchar, $2::varchar, $3::varchar, $4::int)
ON CONFLICT (pstart, hostname, pathname)
DO UPDATE SET val = stats.val + $4::int
`;

queries['save_ledger_data'] = `
INSERT INTO ledger_data(pstart, hostname, journal_id, rest, log_file_size, counters_file_size)
VALUES ($1::varchar, $2::varchar, $3::varchar, $4::jsonb, $5::int, $6::int)
`;

queries['acknowledge_stamp'] = `
UPDATE ledger_data
SET stamped = TRUE
WHERE journal_id = $1::varchar
`;

queries['set_txid'] = `
UPDATE ledger_data
SET txid = $1::varchar
WHERE journal_id = $2::varchar
`;

queries['per_stamped_file'] = `
UPDATE ledger_data
SET txid = $1::varchar, stamped = 't'
WHERE pstart = $2::varchar AND hostname = $3::varchar
`;

queries['update_us_counters'] = `
INSERT INTO usage_stat_counters (
    report_date,
    hostnames_count,
    succ_stamped,
    log_files_size,
    counters_files_size
)
VALUES (
    $1::varchar,
    (SELECT COUNT(*) FROM ledger_data WHERE pstart = $1::varchar),
    (SELECT COUNT(*) FROM ledger_data WHERE pstart = $1::varchar AND stamped = 't'),
    (SELECT SUM(log_file_size) FROM ledger_data WHERE pstart = $1::varchar AND stamped = 't'),
    (SELECT SUM(counters_file_size) FROM ledger_data WHERE pstart = $1::varchar AND stamped = 't')
)
`;

queries['get_us_counters'] = `
SELECT * FROM usage_stat_counters
WHERE report_date >= $1::varchar AND report_date <= $2::varchar
ORDER BY report_date ASC
`;

queries['queue_get_files'] = `
SELECT * FROM files_queue
WHERE status = 'new' OR status = 'failed'
`;

queries['queue_file_ok'] = `
UPDATE files_queue
SET status = 'ok'
WHERE fname = $1::varchar
`;

queries['queue_file_failed'] = `
UPDATE files_queue
SET status = 'failed'
WHERE fname = $1::varchar
`;

queries['queue_clear_ok'] = `
DELETE FROM files_queue WHERE status = 'ok'
`;

module.exports = function (options, debug_msg, on_disconnect, on_error) {

    function run_query(query_name, params, callback) {
        var qid = +(new Date);
        var q = '';
        var prepared = true;
        if (queries[query_name]) {
            debug_msg(`Running ${query_name} with qid = ${qid} and params = ${JSON.stringify(params)}`);
            q = queries[query_name];
        }
        else {
            debug_msg(`Running raw query "${query_name}" with qid = ${qid} and params = ${JSON.stringify(params)}`);
            prepared = false;
            q = query_name;
        }
        pg.connect(options, function (err, client, pgdone) {
            if (err) {
                if (prepared) {
                    on_error(`Error connecting to database on query ${query_name} qid = ${qid}`, err);
                }
                else {
                    on_error(`Error connecting to database on raw query "${query_name}" qid = ${qid}`, err);
                }
                return callback(err);
            }

            client.query(q, params, function (err, result) {
                pgdone();
                // this is a workaround
                if (err && err.code === '23505') {
                    err = null;
                    result = {
                        rows: []
                    };
                }

                if (err) {
                    if (prepared) {
                        on_error(`Query ${query_name} with qid = ${qid} and params = ${JSON.stringify(params)} completed with errors`, err);
                    }
                    else {
                        on_error(`Raw query "${query_name}" with qid = ${qid} and params = ${JSON.stringify(params)} completed with errors`, err);
                    }
                    return callback(err);
                }
                if (prepared) {
                    debug_msg(`Query ${query_name} with qid = ${qid} completed successfully, rows:` + JSON.stringify(result.rows));
                }
                else {
                    debug_msg(`Raw query "${query_name}" with qid = ${qid} completed successfully, rows:` + JSON.stringify(result.rows));
                }
                return callback(null, result.rows);
            });
        });
    }

    return {
        init: function (done) {
            return done();
        },

        incr: function (key_data, done) {
            if (typeof key_data.req_time === 'object') {
                var h = key_data.req_time.toISOString().substr(0, 13);
            }
            else if (typeof key_data.req_time === 'number') {
                var h = (new Date(key_data.req_time)).toISOString().substr(0, 13);
            }
            else {
                var h = key_data.req_time.substr(0, 13);
            }
            key_data.val = key_data.val != null ? key_data.val : 1;

            run_query('incr', [h, key_data.hostname, key_data.pathname, key_data.val], done);
        },

        save_ledger_data: function (log_time, hostname, journal_id, rest, log_file_size, counters_file_size, done) {
            if (typeof log_time === 'object') {
                var h = log_time.toISOString().substr(0, 13);
            }
            else if (typeof log_time === 'number') {
                var h = (new Date(log_time)).toISOString().substr(0, 13);
            }
            else {
                var h = log_time.substr(0, 13);
            }

            run_query('save_ledger_data', [h, hostname, journal_id, rest, log_file_size, counters_file_size], done);
        },

        acknowledge_stamp: function (journal_id, done) {
            if (!journal_id) {
                return done();
            }
            run_query('acknowledge_stamp', [journal_id], done);
        },

        set_txid: function (journal_id, txid, done) {
            if (!journal_id || !txid) {
                return done();
            }
            run_query('set_txid', [txid, journal_id], done);
        },

        search: function (queryp, done) {
            var query = []; // actual SQL query
            var group = [];
            var order = [];

            var params = [];

            if (queryp.aggregation === 'hostname') {
                query.push('SELECT hostname AS hostname, SUM(val) AS sum_vals');
                group.push('hostname');
                order.push('hostname ASC');
            }
            else if (queryp.aggregation === 'hour') {
                query.push('SELECT pstart AS pstart, SUM(val) AS sum_vals');
                group.push('pstart');
                order.push('pstart ASC');
            }
            else {
                query.push('SELECT pstart AS pstart, hostname AS hostname, pathname AS pathname, val AS val');
                order.push('pstart ASC');
                order.push('hostname ASC');
                order.push('pathname ASC');
            }

            query.push('FROM stats');

            var pcnt = (function () { var cnt = 0; return function () { return ++cnt; }; })();

            var conditions = [];
            if (queryp.hostname && queryp.aggregation != 'hour') {
                conditions.push('hostname = $' + pcnt() + '::varchar');
                params.push(queryp.hostname);
            }
            if (queryp.pathname && !queryp.aggregation) {
                conditions.push('pathname = $' + pcnt() + '::varchar');
                params.push(queryp.pathname);
            }
            if (queryp.date_from) {
                conditions.push('pstart >= $' + pcnt() + '::varchar');
                params.push(queryp.date_from.substr(0,13));
            }
            if (queryp.date_to) {
                conditions.push('pstart <= $' + pcnt() + '::varchar');
                params.push(queryp.date_to.substr(0,13));
            }

            if (conditions.length > 0) {
                query.push('WHERE ' + conditions.join(' AND '));
            }
            else {
                return done('Empty WHERE statement in query');
            }

            if (group.length > 0) {
                query.push('GROUP BY ' + group.join(', '));
            }
            if (order.length > 0) {
                query.push('ORDER BY ' + order.join(', '));
            }

            if (!isNaN(parseInt(queryp._page)) && !isNaN(parseInt(queryp._page_size))) {
                query.push( 'LIMIT ' + parseInt(queryp._page_size) );
                query.push( 'OFFSET ' + parseInt(queryp._page_size)*(parseInt(queryp._page) - 1) );
            }

            var query = query.join(' ');

            run_query(query, params, done);
        },

        search_count: function (queryp, done) {
            var query = []; // actual SQL query

            var params = [];

            if (queryp.aggregation === 'hostname') {
                query.push('SELECT COUNT(DISTINCT(hostname))');
            }
            else if (queryp.aggregation === 'hour') {
                query.push('SELECT COUNT(DISTINCT(pstart))');
            }
            else {
                query.push('SELECT COUNT(*)');
            }

            query.push('FROM stats');

            var pcnt = (function () { var cnt = 0; return function () { return ++cnt; }; })();

            var conditions = [];
            if (queryp.hostname && queryp.aggregation != 'hour') {
                conditions.push('hostname = $' + pcnt() + '::varchar');
                params.push(queryp.hostname);
            }
            if (queryp.pathname && !queryp.aggregation) {
                conditions.push('pathname = $' + pcnt() + '::varchar');
                params.push(queryp.pathname);
            }
            if (queryp.date_from) {
                conditions.push('pstart >= $' + pcnt() + '::varchar');
                params.push(queryp.date_from.substr(0,13));
            }
            if (queryp.date_to) {
                conditions.push('pstart <= $' + pcnt() + '::varchar');
                params.push(queryp.date_to.substr(0,13));
            }

            if (conditions.length > 0) {
                query.push('WHERE ' + conditions.join(' AND '));
            }
            else {
                return done('Empty WHERE statement in query');
            }

            var query = query.join(' ');

            run_query(query, params, done);
        },

        search_ledger: function (queryp, done) {
            var query = [];
            var order = [];
            var params = [];

            query.push('SELECT pstart AS pstart, hostname AS hostname, txid AS txid, id AS id');
            query.push('FROM ledger_data');

            var pcnt = (function () { var cnt = 0; return function () { return ++cnt; }; })();

            var conditions = [];
            order.push('pstart ASC');
            if (queryp.hostname) {
                conditions.push('hostname = $' + pcnt() + '::varchar');
                order.push('hostname ASC');
                params.push(queryp.hostname);
            }
            if (queryp.date_from) {
                conditions.push('pstart >= $' + pcnt() + '::varchar');
                params.push(queryp.date_from.substr(0,13));
            }
            if (queryp.date_to) {
                conditions.push('pstart <= $' + pcnt() + '::varchar');
                params.push(queryp.date_to.substr(0,13));
            }

            if (conditions.length > 0) {
                query.push('WHERE ' + conditions.join(' AND '));
            }
            else {
                return done('Empty WHERE statement in query');
            }

            if (order.length > 0) {
                query.push('ORDER BY ' + order.join(', '));
            }

            if (!isNaN(parseInt(queryp._page)) && !isNaN(parseInt(queryp._page_size))) {
                query.push( 'LIMIT ' + parseInt(queryp._page_size) );
                query.push( 'OFFSET ' + parseInt(queryp._page_size)*(parseInt(queryp._page) - 1) );
            }

            var query = query.join(' ');

            run_query(query, params, done);
        },

        search_ledger_count: function (queryp, done) {
            var query = [];
            var params = [];

            query.push('SELECT COUNT(*)');
            query.push('FROM ledger_data');

            var pcnt = (function () { var cnt = 0; return function () { return ++cnt; }; })();

            var conditions = [];
            if (queryp.hostname) {
                conditions.push('hostname = $' + pcnt() + '::varchar');
                params.push(queryp.hostname);
            }
            if (queryp.date_from) {
                conditions.push('pstart >= $' + pcnt() + '::varchar');
                params.push(queryp.date_from.substr(0,13));
            }
            if (queryp.date_to) {
                conditions.push('pstart <= $' + pcnt() + '::varchar');
                params.push(queryp.date_to.substr(0,13));
            }

            if (conditions.length > 0) {
                query.push('WHERE ' + conditions.join(' AND '));
            }
            else {
                return done('Empty WHERE statement in query');
            }

            var query = query.join(' ');

            run_query(query, params, done);
        },

        get_ledger_data_by_id: function (id, done) {
            if ( isNaN(parseInt(id)) ) {
                return done('Invalid id');
            }
            var id = parseInt(id);
            var query = 'SELECT pstart, hostname, journal_id, rest FROM ledger_data WHERE id=$1::int';
            var params = [id];
            run_query(query, params, done);
        },

        per_stamped_file: function (pstart, hostname, txid, done) {
            if (!pstart || !hostname || !txid) {
                return done();
            }
            run_query('per_stamped_file', [txid, pstart, hostname], done);
        },

        update_usage_stat: function (params, done) {
            var log_time = params.log_time.substr(0,13);
            run_query('update_us_counters', [log_time], done);
        },

        get_usage_stat: function (queryp, done) {
            run_query('get_us_counters', [queryp.date_from.substr(0,13), queryp.date_to.substr(0,13)], function (err, rows) {
                if (err) {
                    return done(err);
                }

                return done(null, {
                    counters: rows
                });
            });
        },

        queue_get_files: function (done) {
            run_query('queue_get_files', [], done);
        },

        queue_file_ok: function (fname, done) {
            run_query('queue_file_ok', [fname], done);
        },

        queue_file_failed: function (fname, done) {
            run_query('queue_file_failed', [fname], done);
        },

        queue_clear_ok: function (done) {
            run_query('queue_clear_ok', [], done);
        },

        queue_insert_new: function (fnames, done) {
            var q = '';
            q += 'INSERT INTO files_queue (fname) ';
            q += 'VALUES (\'' + fnames.join('\'),\n(\'') + '\')';
            run_query(q, [], done);
        }
    };
};
