/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
    PagedResults,
    Source,
    Manga,
    Chapter,
    ChapterDetails,
    HomeSection,
    SearchRequest,
    SourceInfo,
    LanguageCode,
    TagType,
    MangaStatus,
    MangaTile,
    Tag,
    RequestHeaders,
    ContentRating,
    TagSection,
    Section,
    HomeSectionType,
    MangaUpdates
} from 'paperback-extensions-common'

import entities = require('entities')
import {
    contentSettings,
    getLanguages,
    getDemographics,
    thumbnailSettings,
    getHomepageThumbnail,
    getSearchThumbnail,
    getMangaThumbnail,
    resetSettings,
    getDataSaver,
    getSkipSameChapter,
    homepageSettings,
    getEnabledRecommendations,
    getEnabledHomePageSections
} from './MangaDexSettings'
import {
    requestMetadata,
    MDLanguages,
    URLBuilder,
    MDImageQuality
} from './MangaDexHelper'
import {
    addRecommendedId,
    getRecommendedIds
} from './MangaDexSimilarManga'
import tagJSON from './external/tag.json'

const MANGADEX_DOMAIN = 'https://mangadex.org'
const MANGADEX_API = 'https://api.mangadex.org'
const COVER_BASE_URL = 'https://uploads.mangadex.org/covers'

// Titles recommendations are shown on the homepage when enabled in source settings.
// Recommendations are made using https://github.com/Similar-Manga
const RECOMMENDATION_URL = 'https://framboisepi.github.io/SimilarData'

export const MangaDexInfo: SourceInfo = {
    author: 'nar1n',
    description: 'Extension that pulls manga from MangaDex',
    icon: 'icon.png',
    name: 'MangaDex recommendation',
    version: '2.0.8',
    authorWebsite: 'https://github.com/nar1n',
    websiteBaseURL: MANGADEX_DOMAIN,
    contentRating: ContentRating.EVERYONE,
    language: LanguageCode.ENGLISH,
    sourceTags: [
        {
            text: 'Recommended',
            type: TagType.BLUE,
        },
        {
            text: 'Notifications',
            type: TagType.GREEN
        }
    ],
}

export class MangaDex extends Source {

    requestManager = createRequestManager({
        requestsPerSecond: 4,
        requestTimeout: 15000,
    })

    stateManager = createSourceStateManager({})

    override async getSourceMenu(): Promise<Section> {
        return Promise.resolve(createSection({
            id: 'main',
            header: 'Source Settings',
            rows: () => Promise.resolve([
                contentSettings(this.stateManager),
                thumbnailSettings(this.stateManager),
                homepageSettings(this.stateManager),
                resetSettings(this.stateManager),
            ])
        }))
    }

    override getMangaShareUrl(mangaId: string): string {
        return `${MANGADEX_DOMAIN}/title/${mangaId}`
    }

    override globalRequestHeaders(): RequestHeaders {
        return {
            referer: `${MANGADEX_DOMAIN}/`
        }
    }

    override async getTags(): Promise<TagSection[]> {
        const sections: Record<string, TagSection> = {}

        for(const tag of tagJSON) {
            const group = tag.data.attributes.group

            if(sections[group] == null) {
                sections[group] = createTagSection({
                    id: group,
                    label: group.charAt(0).toUpperCase() + group.slice(1),
                    tags: []
                })
            }
            const tagObject = createTag({id: tag.data.id, label: tag.data.attributes.name.en})
            sections[group]!.tags = [...sections[group]?.tags ?? [], tagObject]
        }

        return Object.values(sections)
    }

    async getMDHNodeURL(chapterId: string): Promise<string> {
        const request = createRequestObject({
            url: `${MANGADEX_API}/at-home/server/${chapterId}`,
            method: 'GET',
        })
    
        const response = await this.requestManager.schedule(request, 1)
        const json = (typeof response.data) === 'string' ? JSON.parse(response.data) : response.data

        return json.baseUrl
    }

    async getCustomListRequestURL(listId: string, demographics: string[]): Promise<string> {
        const request = createRequestObject({
            url: `${MANGADEX_API}/list/${listId}`,
            method: 'GET',
        })
    
        const response = await this.requestManager.schedule(request, 1)
        const json = (typeof response.data) === 'string' ? JSON.parse(response.data) : response.data

        return new URLBuilder(MANGADEX_API)
            .addPathComponent('manga')
            .addQueryParameter('limit', 100)
            .addQueryParameter('contentRating', demographics)
            .addQueryParameter('includes', ['cover_art'])
            .addQueryParameter('ids', json.relationships.filter((x: any) => x.type == 'manga').map((x: any) => x.id))
            .buildUrl()
    }

    async getMangaDetails(mangaId: string): Promise<Manga> {
        if (!mangaId.includes('-')) {
            // Legacy Id
            throw new Error('OLD ID: PLEASE MIGRATE')
        }

        const request = createRequestObject({
            url: new URLBuilder(MANGADEX_API)
                .addPathComponent('manga')
                .addPathComponent(mangaId)
                .addQueryParameter('includes', ['author', 'artist', 'cover_art'])
                .buildUrl(),
            method: 'GET',
        })
    
        const response = await this.requestManager.schedule(request, 1)
        const json = (typeof response.data) === 'string' ? JSON.parse(response.data) : response.data

        const mangaDetails = json.data.attributes
        const titles = [
            ...Object.values(mangaDetails.title),
            ...mangaDetails.altTitles.flatMap((x: never) => Object.values(x))
        ].map((x: string) => this.decodeHTMLEntity(x))
        const desc = this.decodeHTMLEntity(mangaDetails.description.en).replace(/\[\/{0,1}[bus]\]/g, '')  // Get rid of BBcode tags

        let status = MangaStatus.COMPLETED
        if (mangaDetails.status == 'ongoing') {
            status = MangaStatus.ONGOING
        }
        const tags: Tag[] = []
        for (const tag of mangaDetails.tags) {
            const tagName: {[index: string]: string} = tag.attributes.name
            tags.push(createTag({
                id: tag.id,
                label: Object.keys(tagName).map(keys => tagName[keys])[0] ?? 'Unknown'
            }))
        }
    
        const author = json.relationships.filter((x: any) => x.type == 'author').map((x: any) => x.attributes.name).join(', ')
        const artist = json.relationships.filter((x: any) => x.type == 'artist').map((x: any) => x.attributes.name).join(', ')

        const coverFileName = json.relationships.filter((x: any) => x.type == 'cover_art').map((x: any) => x.attributes?.fileName)[0]
        let image: string
        if (coverFileName) {
            image = `${COVER_BASE_URL}/${mangaId}/${coverFileName}${MDImageQuality.getEnding(await getMangaThumbnail(this.stateManager))}`
        } else {
            image = 'https://mangadex.org/_nuxt/img/cover-placeholder.d12c3c5.jpg'
        }

        return createManga({
            id: mangaId,
            titles,
            image,
            author,
            artist,
            desc,
            rating: 5,
            status,
            tags: [createTagSection({
                id: 'tags',
                label: 'Tags',
                tags: tags
            })]
        })
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        if (!mangaId.includes('-')) {
            // Legacy Id
            throw new Error('OLD ID: PLEASE MIGRATE')
        }

        const languages: string[] = await getLanguages(this.stateManager)
        const skipSameChapter = await getSkipSameChapter(this.stateManager)
        const collectedChapters: string[] = []

        const chapters: Chapter[] = []
        let offset = 0
        let sortingIndex = 0

        let hasResults = true
        while (hasResults) {
            const request = createRequestObject({
                url: new URLBuilder(MANGADEX_API)
                    .addPathComponent('manga')
                    .addPathComponent(mangaId)
                    .addPathComponent('feed')
                    .addQueryParameter('limit', 500)
                    .addQueryParameter('offset', offset)
                    .addQueryParameter('includes', ['scanlation_group'])
                    .addQueryParameter('translatedLanguage', languages)
                    .addQueryParameter('order', {'volume': 'desc', 'chapter': 'desc'})
                    .buildUrl(),
                method: 'GET',
            })
            const response = await this.requestManager.schedule(request, 1)
            const json = (typeof response.data) === 'string' ? JSON.parse(response.data) : response.data
            offset += 500

            if(json.results === undefined) throw new Error(`Failed to parse json results for ${mangaId}`)

            for (const chapter of json.results) {
                const chapterId = chapter.data.id
                const chapterDetails = chapter.data.attributes
                const name =  this.decodeHTMLEntity(chapterDetails.title)
                const chapNum = Number(chapterDetails?.chapter)
                const volume = Number(chapterDetails?.volume)
                const langCode: any = MDLanguages.getPBCode(chapterDetails.translatedLanguage)
                const time = new Date(chapterDetails.publishAt)
                const group = chapter.relationships.filter((x: any) => x.type == 'scanlation_group').map((x: any) => x.attributes.name).join(', ')

                const identifier = `${volume}-${chapNum}-${chapterDetails.translatedLanguage}`
                if (!collectedChapters.includes(identifier) || !skipSameChapter) {
                    chapters.push(createChapter({
                        id: chapterId,
                        mangaId: mangaId,
                        name,
                        chapNum,
                        volume,
                        langCode,
                        group,
                        time,
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore
                        sortingIndex
                    }))

                    collectedChapters.push(identifier)
                    sortingIndex--
                }
            }

            if (json.total <= offset) {
                hasResults = false
            }
        }

        return chapters
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        if (!chapterId.includes('-')) {
            // Numeric ID
            throw new Error('OLD ID: PLEASE REFRESH AND CLEAR ORPHANED CHAPTERS')
        }

        const serverUrl = await this.getMDHNodeURL(chapterId)
        const dataSaver = await getDataSaver(this.stateManager)

        const request = createRequestObject({
            url: `${MANGADEX_API}/chapter/${chapterId}`,
            method: 'GET',
        })

        const response = await this.requestManager.schedule(request, 1)
        const json = (typeof response.data) === 'string' ? JSON.parse(response.data) : response.data

        const chapterDetails = json.data.attributes

        let pages: string[]
        if (dataSaver) {
            pages = chapterDetails.dataSaver.map(
                (x: string) => `${serverUrl}/data-saver/${chapterDetails.hash}/${x}`
            )
        } else {
            pages = chapterDetails.data.map(
                (x: string) => `${serverUrl}/data/${chapterDetails.hash}/${x}`
            )
        }

        // The chapter is being read, add the mangaId to the recommendation list
        addRecommendedId(this.stateManager, mangaId)

        return createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages,
            longStrip: false
        })
    }

    async searchRequest(query: SearchRequest, metadata: requestMetadata): Promise<PagedResults> {
        const demographics: string[] = await getDemographics(this.stateManager)
        const offset: number = metadata?.offset ?? 0
        const results: MangaTile[] = []
        const searchType = query.title?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i) ? 'ids[]' : 'title'

        const url = new URLBuilder(MANGADEX_API)
            .addPathComponent('manga')
            .addQueryParameter(searchType, (query.title?.length ?? 0) > 0 ? encodeURIComponent(query.title!) : undefined)
            .addQueryParameter('limit', 100)
            .addQueryParameter('offset', offset)
            .addQueryParameter('contentRating', demographics)
            .addQueryParameter('includes', ['cover_art'])
            .addQueryParameter('includedTags', query.includedTags?.map(x => x.id))
            .addQueryParameter('includedTagsMode', query.includeOperator)
            .addQueryParameter('excludedTags', query.excludedTags?.map(x => x.id))
            .addQueryParameter('excludedTagsMode', query.excludeOperator)
            .buildUrl()

        const request = createRequestObject({
            url: url,
            method: 'GET',
        })

        const response = await this.requestManager.schedule(request, 1)
        if (response.status != 200) {
            return createPagedResults({results})
        }

        const json = (typeof response.data) === 'string' ? JSON.parse(response.data) : response.data

        if(json.results === undefined) {throw new Error('Failed to parse json for the given search')}

        for (const manga of json.results) {
            const mangaId = manga.data.id
            const mangaDetails = manga.data.attributes
            const title = this.decodeHTMLEntity(Object.values(mangaDetails.title)[0] as string)
            const coverFileName = manga.relationships.filter((x: any) => x.type == 'cover_art').map((x: any) => x.attributes?.fileName)[0]
            let image: string
            if (coverFileName) {
                image = `${COVER_BASE_URL}/${mangaId}/${coverFileName}${MDImageQuality.getEnding(await getSearchThumbnail(this.stateManager))}`
            } else {
                image = 'https://mangadex.org/_nuxt/img/cover-placeholder.d12c3c5.jpg'
            }

            results.push(createMangaTile({
                id: mangaId,
                title: createIconText({text: title}),
                image
            }))
        }

        return createPagedResults({
            results,
            metadata: {offset: offset + 100}
        })
    }

    override async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const promises: Promise<void>[] = []
        const demographics: string[] = await getDemographics(this.stateManager)

        // If the user want to see recommendation on the homepage, we process them
        const enabled_homepage_sections = await getEnabledHomePageSections(this.stateManager)

        const sections = [
            {
                request: createRequestObject({
                    url: await this.getCustomListRequestURL('a153b4e6-1fcc-4f45-a990-f37f989c0d74', demographics),
                    method: 'GET',
                }),
                section: createHomeSection({
                    id: 'seasonal',
                    title: 'Seasonal',
                    type: HomeSectionType.featured
                }),
            },
            {
                request: createRequestObject({
                    url: new URLBuilder(MANGADEX_API)
                        .addPathComponent('manga')
                        .addQueryParameter('limit', 20)
                        .addQueryParameter('contentRating', demographics)
                        .addQueryParameter('includes', ['cover_art'])
                        .buildUrl(),
                    method: 'GET',
                }),
                section: createHomeSection({
                    id: 'popular',
                    title: 'Popular',
                    view_more: true,
                }),
            },
            {
                request: createRequestObject({
                    url: new URLBuilder(MANGADEX_API)
                        .addPathComponent('manga')
                        .addQueryParameter('limit', 20)
                        .addQueryParameter('contentRating', demographics)
                        .addQueryParameter('includes', ['cover_art'])
                        .addQueryParameter('order', {'updatedAt': 'desc'})
                        .buildUrl(),
                    method: 'GET',
                }),
                section: createHomeSection({
                    id: 'recently_updated',
                    title: 'Recently Updated',
                    view_more: true,
                }),
            },
        ]

        for (const section of sections) {
            // We only add the section if it is requested by the user in settings
            if (enabled_homepage_sections.includes(section.section.id)) {

                // Let the app load empty sections
                sectionCallback(section.section)

                // Get the section data
                promises.push(
                    this.requestManager.schedule(section.request, 1).then(async response => {
                        const json = (typeof response.data) === 'string' ? JSON.parse(response.data) : response.data
                        const results = []

                        if(json.results === undefined) throw new Error(`Failed to parse json results for section ${section.section.title}`)

                        for (const manga of json.results) {
                            const mangaId = manga.data.id
                            const mangaDetails = manga.data.attributes
                            const title = this.decodeHTMLEntity(Object.values(mangaDetails.title)[0] as string)
                            const coverFileName = manga.relationships.filter((x: any) => x.type == 'cover_art').map((x: any) => x.attributes?.fileName)[0]
                            let image: string
                            if (coverFileName) {
                                image = `${COVER_BASE_URL}/${mangaId}/${coverFileName}${MDImageQuality.getEnding(await getHomepageThumbnail(this.stateManager))}`
                            } else {
                                image = 'https://mangadex.org/_nuxt/img/cover-placeholder.d12c3c5.jpg'
                            }

                            results.push(createMangaTile({
                                id: mangaId,
                                title: createIconText({text: title}),
                                image
                            }))
                        }

                        section.section.items = results
                        sectionCallback(section.section)
                    }),
                )
            }
        }

        // If the user want to see recommendations on the homepage, we process them
        if (getEnabledRecommendations(this.stateManager)) {
            const recommendedIds = await getRecommendedIds(this.stateManager)

            for (const recommendedId of recommendedIds) {
                // First we fetch similar titles
                const similarRequest = createRequestObject({
                    url: `${RECOMMENDATION_URL}/similar/${recommendedId}.json`,
                    method: 'GET',
                })
                promises.push(
                    this.requestManager.schedule(similarRequest, 1).then(async similarResponse => {

                        // We should only process if the response is valid
                        // We won't throw an error but silently pass as an error occurre with 
                        // titles unsupported by SimilarManga (new titles for example)
                        if (similarResponse.status !== 200) {
                            console.log(`Could not fetch similar titles for id: ${recommendedId}, request failed with status ${similarResponse.status}`)
                        } else {
                            const similarJson = (typeof similarResponse.data) === 'string' ? JSON.parse(similarResponse.data) : similarResponse.data
                            
                            // We should only process if the result is valid
                            // We won't throw an error but silently pass as an error occurre with 
                            // titles unsupported by SimilarManga (new titles for example)
                            if (similarJson.id === undefined) {
                                console.log('Could not fetch similar titles for id: ' + recommendedId + ', json is invalid')
                            } else {
                                // Now we know the title of the recommended manga, we can thus create the section
                                const section = createHomeSection({
                                    id: recommendedId,
                                    // Can titles be html encoded?
                                    title: this.decodeHTMLEntity(similarJson.title.en),
                                    view_more: false,
                                })
                                // Let the app load empty sections
                                sectionCallback(section)

                                // We make the list of similar titles
                                // The first element is the "recommendation title". Other ids are sorted by decreasing similarity
                                const similarIds = [recommendedId]
                                for (const manga of similarJson.matches) {
                                    similarIds.push(manga.id)
                                }

                                // Then we request information about these ids from MangaDex
                                // Titles and ids are available in SimilarManga database. This step is required to get thumbnails.

                                // The issue is MangaDex result does not preserve ids order
                                // Thus we construct an object `tiles` that will contain information about each titles
                                // We will finally use this object to generate the sorted MangaTiles list
                                
                                const tiles: { [id: string] : any; } = {}

                                const mdRequest = createRequestObject({
                                    url: new URLBuilder(MANGADEX_API)
                                        .addPathComponent('manga')
                                        .addQueryParameter('ids', similarIds)
                                        .addQueryParameter('limit', similarIds.length)
                                        .addQueryParameter('includes', ['cover_art'])
                                        .buildUrl(),
                                    method: 'GET',
                                })

                                const mdResponse = await this.requestManager.schedule(mdRequest, 1)
                                const mdJson = (typeof mdResponse.data) === 'string' ? JSON.parse(mdResponse.data) : mdResponse.data
                                
                                // We process returned data
                                for (const manga of mdJson.results) {
                                    const mangaDetails = manga.data.attributes
            
                                    const mangaId = manga.data.id
            
                                    const titles = [
                                        ...Object.values(mangaDetails.title),
                                        ...mangaDetails.altTitles.flatMap((x: never) => Object.values(x))
                                    ].map((x: string) => this.decodeHTMLEntity(x))
            
                                    const title = (typeof titles[0]) === 'undefined' ?  'default' : titles[0]
            
                                    const coverFileName = manga.relationships.filter((x: any) => x.type == 'cover_art').map((x: any) => x.attributes?.fileName)[0]
                                    let image: string
                                    if (coverFileName) {
                                        image = `${COVER_BASE_URL}/${mangaId}/${coverFileName}${MDImageQuality.getEnding(await getMangaThumbnail(this.stateManager))}`
                                    } else {
                                        image = 'https://mangadex.org/_nuxt/img/cover-placeholder.d12c3c5.jpg'
                                    }
            
                                    tiles[mangaId] = {
                                        id: mangaId,
                                        title: title!,
                                        image
                                    }
                                }

                                // Generate the MangaTiles list, sorted by decreasing similarity
                                const results = []
                                for (const id of similarIds) {
                                    // `tiles[id]` may not exist, for example if the id is filtered by demographic by MD api
                                    if (tiles[id].title === undefined) {
                                        console.log(`Id ${id} was not returned by MangaDex api for recommendation id ${recommendedId}`)
                                    } else {
                                        results.push(createMangaTile({
                                            id: id,
                                            title: createIconText({text: tiles[id].title}),
                                            image: tiles[id].image
                                        }))
                                    }
                                }

                                section.items = results
                                sectionCallback(section)
                            }
                        }
                    })
                )
            }
        }

        // Make sure the function completes
        await Promise.all(promises)
    }

    override async getViewMoreItems(homepageSectionId: string, metadata: requestMetadata): Promise<PagedResults> {
        const offset: number = metadata?.offset ?? 0
        const collectedIds: string[] = metadata?.collectedIds ?? []
        const results: MangaTile[] = []
        const demographics: string[] = await getDemographics(this.stateManager)
        let url = ''

        switch(homepageSectionId) {
            case 'popular': {
                url = new URLBuilder(MANGADEX_API)
                    .addPathComponent('manga')
                    .addQueryParameter('limit', 100)
                    .addQueryParameter('offset', offset)
                    .addQueryParameter('contentRating', demographics)
                    .addQueryParameter('includes', ['cover_art'])
                    .buildUrl()
                break
            }
            case 'recently_updated': {
                url = new URLBuilder(MANGADEX_API)
                    .addPathComponent('manga')
                    .addQueryParameter('limit', 100)
                    .addQueryParameter('offset', offset)
                    .addQueryParameter('contentRating', demographics)
                    .addQueryParameter('includes', ['cover_art'])
                    .addQueryParameter('order', {'updatedAt': 'desc'})
                    .buildUrl()
                break
            }
        }

        const request = createRequestObject({
            url,
            method: 'GET',
        })

        const response = await this.requestManager.schedule(request, 1)
        const json = (typeof response.data) === 'string' ? JSON.parse(response.data) : response.data

        if(json.results === undefined) throw new Error('Failed to parse json results for getViewMoreItems')

        for (const manga of json.results) {
            const mangaId = manga.data.id
            const mangaDetails = manga.data.attributes
            const title = this.decodeHTMLEntity(Object.values(mangaDetails.title)[0] as string)
            const coverFileName = manga.relationships.filter((x: any) => x.type == 'cover_art').map((x: any) => x.attributes?.fileName)[0]
            let image: string
            if (coverFileName) {
                image = `${COVER_BASE_URL}/${mangaId}/${coverFileName}${MDImageQuality.getEnding(await getHomepageThumbnail(this.stateManager))}`
            } else {
                image = 'https://mangadex.org/_nuxt/img/cover-placeholder.d12c3c5.jpg'
            }

            if (!collectedIds.includes(mangaId)) {
                results.push(createMangaTile({
                    id: mangaId,
                    title: createIconText({text: title}),
                    image
                }))
                collectedIds.push(mangaId)
            }
        }

        return createPagedResults({
            results,
            metadata: {offset: offset + 100, collectedIds}
        })
    }

    override async filterUpdatedManga(mangaUpdatesFoundCallback: (updates: MangaUpdates) => void, time: Date, ids: string[]): Promise<void> {
        let offset = 0
        const maxRequests = 100
        let loadNextPage = true
        const updatedManga: string[] = []
        const updatedAt = time.toISOString().split('.')[0] // They support a weirdly truncated version of an ISO timestamp
        const languages: string[] = await getLanguages(this.stateManager)

        while (loadNextPage) {
            const request = createRequestObject({
                url: new URLBuilder(MANGADEX_API)
                    .addPathComponent('chapter')
                    .addQueryParameter('limit', 100)
                    .addQueryParameter('offset', offset)
                    .addQueryParameter('publishAtSince', updatedAt)
                    .addQueryParameter('order', {'publishAt': 'desc'})
                    .addQueryParameter('translatedLanguage', languages)
                    .buildUrl(),
                method: 'GET',
            })

            const response = await this.requestManager.schedule(request, 1)

            // If we have no content, there are no updates available
            if(response.status == 204) {
                return
            }

            const json = (typeof response.data) === 'string' ? JSON.parse(response.data) : response.data

            if(json.results === undefined) {
                // Log this, no need to throw.
                console.log(`Failed to parse JSON results for filterUpdatedManga using the date ${updatedAt} and the offset ${offset}`)
                return
            }

            const mangaToUpdate: string[] = []
            for (const chapter of json.results) {
                const mangaId = chapter.relationships.filter((x: any)=> x.type == 'manga')[0]?.id

                if (ids.includes(mangaId) && !updatedManga.includes(mangaId)) {
                    mangaToUpdate.push(mangaId)
                    updatedManga.push(mangaId)
                }
            }

            offset = offset + 100
            if (json.total <= offset || offset >= 100 * maxRequests) {
                loadNextPage = false
            }
            if (mangaToUpdate.length > 0) {
                mangaUpdatesFoundCallback(createMangaUpdates({
                    ids: mangaToUpdate
                }))
            }
        }
    }

    decodeHTMLEntity(str: string): string {
        return entities.decodeHTML(str)
    }
}
