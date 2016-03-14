module.exports = {
    config: {
        logger: {
            name: 'config',
            level: (process.env.NODE_ENV === 'development' ? 0 : 1)
        },
        filename: 'config.yaml',
    },

    pixel: {
        logger: {
            name: 'pixel',
            level: 1
        },
        port: parseInt(process.env.PORT) || 4321,
        endpoints: ['/pixel.gif'],
        log_404_as_error: true,
        id_length: 12,
        cookies: {
            sign_keys: ['s3Cret.1', '$ekR3T.2', 'CEKPET.3'],
            algorithm: 'xor',
            password:  'N0 pA$ar@n'
        }
    },

    register: {
        logger: {
            name: 'register',
            level: 1
        },
        folder: './requests',
        prune_interval: 30*60*1000,
        cache_options: {
            max:    5000,
            maxAge: 60*60*1000
        },
    },

    timestamper: {
        logger: {
            name: 'timestamper',
            level: 1
        },
        logs_folder: process.argv[2] || './requests',
        extension: 'log.1.gz',
        processed_counters_folder: './processed'
    },

    counters_storage: {
        logger: {
            name: 'storage',
            level: 1
        },
        type: 'postgres',
        options: {
            user: '',
            password: '',
            host: 'localhost',
            port: 5432,
            database: 'pixel',
            poolSize: 10
        }
    },

    ledger: {
        logger: {
            name: 'ledger',
            level: 1
        },
        type: 'acronis',
        options: {
            base_url: 'http://localhost:8080/api',
            timeout: 10000,
            max_tries: 3,
            user: {
                email: '',
                accessKey: '',
                accessSecret: ''
            }
        }
    },
};
